#include "hexsync.h"
#include "esphome/core/log.h"
#include "esphome/core/hal.h"
#include "esphome/components/wifi/wifi_component.h"
#include <esp_now.h>
#include <esp_wifi.h>
#include <cmath>
#include <cstring>

namespace esphome {
namespace hexsync {

static const char *const TAG = "hexsync";
static const uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
QueueHandle_t HexSync::queue_ = nullptr;

struct RxItem {
  HxPacket pkt;
  uint32_t t;
};

// ESP-IDF 5.x receive callback signature.
static void recv_cb_idf5(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  HexSync::on_recv_(info ? info->src_addr : nullptr, data, len);
}

void HexSync::on_recv_(const uint8_t *mac, const uint8_t *data, int len) {
  // Runs in the Wi-Fi task: only validate and enqueue.
  if (queue_ == nullptr || len != (int) sizeof(HxPacket)) return;
  RxItem item;
  memcpy(&item.pkt, data, sizeof(HxPacket));
  if (item.pkt.magic != HX_MAGIC || item.pkt.version != HX_VERSION) return;
  item.t = millis();
  xQueueSend(queue_, &item, 0);
}

void HexSync::setup() {
  queue_ = xQueueCreate(16, sizeof(RxItem));
  leader_id_ = 0;
}

bool HexSync::init_espnow_() {
  // ESP-NOW rides on the STA interface, so it uses the AP's channel.
  // All tiles join the same AP -> all share one channel. If the AP changes
  // channel, tiles reconnect and follow it; we re-check channel each loop.
  uint8_t prim = 0;
  wifi_second_chan_t sec;
  if (esp_wifi_get_channel(&prim, &sec) != ESP_OK) return false;
  if (esp_now_init() != ESP_OK) {
    ESP_LOGE(TAG, "esp_now_init failed");
    return false;
  }
  esp_now_register_recv_cb(recv_cb_idf5);
  esp_now_peer_info_t peer{};
  memcpy(peer.peer_addr, BCAST, 6);
  peer.channel = 0;  // 0 = current channel
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;  // broadcast cannot be encrypted in ESP-NOW
  if (esp_now_add_peer(&peer) != ESP_OK) {
    ESP_LOGE(TAG, "add broadcast peer failed");
    return false;
  }
  channel_ = prim;
  ESP_LOGI(TAG, "ESP-NOW up on channel %u", prim);
  return true;
}

uint32_t HexSync::effect_clock() const { return millis() + (uint32_t) offset_ms_; }

bool HexSync::i_should_lead_() const {
  if (static_leader_ != 0) return static_leader_ == tile_id_;
  if (leader_id_ == 0 || leader_id_ == tile_id_) return true;
  if (millis() - last_leader_rx_ > timeout_ms_) return true;  // failover
  return priority_ < leader_prio_;
}

void HexSync::send_(uint8_t type) {
  if (!espnow_ok_) return;
  HxPacket p{};
  p.magic = HX_MAGIC;
  p.version = HX_VERSION;
  p.type = type;
  p.sender = tile_id_;
  p.priority = priority_;
  p.seq = ++seq_;
  p.clock_ms = effect_clock();
  p.gen = params_.gen;
  p.effect = params_.effect;
  p.hue = params_.hue;
  p.sat = params_.sat;
  p.value = params_.value;
  p.speed = params_.speed;
  p.scale = params_.scale;
  p.channel = channel_;
  esp_now_send(BCAST, (const uint8_t *) &p, sizeof(p));
}

void HexSync::handle_(const HxPacket &p, uint32_t rx_local) {
  if (p.sender == tile_id_) return;
  rx_count_++;
  if (p.channel != channel_) ESP_LOGW(TAG, "peer %u reports channel %u, mine %u", p.sender, p.channel, channel_);

  // Parameters: newest generation wins, from anyone (HA may call any tile).
  if (p.gen > params_.gen) {
    params_.gen = p.gen;
    params_.effect = p.effect;
    params_.hue = p.hue;
    params_.sat = p.sat;
    params_.value = p.value;
    params_.speed = p.speed;
    params_.scale = p.scale;
  }
  if (p.type != HX_BEACON) return;

  // Leader election: static leader, or lowest priority value heard recently.
  bool accept;
  if (static_leader_ != 0) {
    accept = (p.sender == static_leader_);
  } else {
    bool stale = (millis() - last_leader_rx_) > timeout_ms_;
    accept = p.sender == leader_id_ || stale || p.priority < leader_prio_ ||
             (is_leader() && p.priority < priority_);
  }
  if (!accept) return;
  if (p.sender != leader_id_) {
    ESP_LOGI(TAG, "leader -> tile %u", p.sender);
    have_leader_seq_ = false;
    offset_locked_ = false;
  }
  // Sequence check: drop duplicates / reordered beacons (16-bit wrap safe).
  if (have_leader_seq_ && (int16_t)(p.seq - last_leader_seq_) <= 0) {
    drop_count_++;
    return;
  }
  have_leader_seq_ = true;
  last_leader_seq_ = p.seq;
  leader_id_ = p.sender;
  leader_prio_ = p.priority;
  last_leader_rx_ = millis();

  // Clock sync. Air + stack latency only ever makes a sample *late*, so the
  // sample with the largest offset is the best one. Track it, but let it
  // decay slowly (1 ms per beacon) so crystal drift (~tens of ppm) is followed.
  int32_t sample = (int32_t)(p.clock_ms - rx_local) + 1;  // +1 ms ESTIMATED airtime
  if (!offset_locked_) {
    offset_ms_ = sample;
    offset_locked_ = true;
  } else if (sample > offset_ms_) {
    offset_ms_ = sample;
  } else if (offset_ms_ - sample > 50) {
    offset_ms_ = sample;  // big jump: leader rebooted / changed
  } else {
    offset_ms_ -= 1;
  }
}

void HexSync::loop() {
  if (!espnow_ok_) {
    if (wifi::global_wifi_component != nullptr && wifi::global_wifi_component->is_connected())
      espnow_ok_ = init_espnow_();
    if (!espnow_ok_) return;
  }
  uint8_t prim = 0;
  wifi_second_chan_t sec;
  if (esp_wifi_get_channel(&prim, &sec) == ESP_OK && prim != channel_) {
    ESP_LOGI(TAG, "channel %u -> %u", channel_, prim);
    channel_ = prim;
  }
  RxItem item;
  while (xQueueReceive(queue_, &item, 0) == pdTRUE) handle_(item.pkt, item.t);

  if (i_should_lead_()) {
    if (leader_id_ != tile_id_) {
      ESP_LOGI(TAG, "I am leader (tile %d)", tile_id_);
      leader_id_ = tile_id_;
      leader_prio_ = priority_;
    }
    uint32_t now = millis();
    if (now - last_beacon_ >= beacon_ms_) {
      last_beacon_ = now;
      send_(HX_BEACON);
    }
  }
}

void HexSync::set_effect(int effect, int hue, int sat, int value, int speed, int scale) {
  // Generation = wall clock-ish: effect clock in ms, always above the current one.
  uint32_t g = effect_clock();
  params_.gen = (g > params_.gen) ? g : params_.gen + 1;
  params_.effect = (uint8_t) effect;
  params_.hue = (uint8_t) hue;
  params_.sat = (uint8_t) sat;
  params_.value = (uint8_t) value;
  params_.speed = (uint16_t) speed;
  params_.scale = (uint16_t) (scale < 1 ? 1 : scale);
  // Burst 3x: broadcast has no ACK/retry.
  for (int i = 0; i < 3; i++) send_(HX_SET);
}

static Color hsv(uint8_t h, uint8_t s, uint8_t v) {
  float hf = h / 255.0f * 6.0f, sf = s / 255.0f, vf = v / 255.0f;
  int i = (int) hf % 6;
  float f = hf - floorf(hf), p = vf * (1 - sf), q = vf * (1 - sf * f), t = vf * (1 - sf * (1 - f));
  float r, g, b;
  switch (i) {
    case 0: r = vf; g = t; b = p; break;
    case 1: r = q; g = vf; b = p; break;
    case 2: r = p; g = vf; b = t; break;
    case 3: r = p; g = q; b = vf; break;
    case 4: r = t; g = p; b = vf; break;
    default: r = vf; g = p; b = q; break;
  }
  return Color(r * 255, g * 255, b * 255);
}

void HexSync::render(light::AddressableLight &it) {
  const int n = it.size();
  if (n <= 0) return;
  const float t = effect_clock() / 1000.0f;
  const float spd = params_.speed / 1000.0f;   // cycles per second
  const float scale = params_.scale / 100.0f;  // tiles per cycle
  // Axial (pointy-top) -> 2D, in tile units.
  const float cx = 1.7320508f * (q_ + r_ / 2.0f);
  const float cy = 1.5f * r_;
  const float rot = rot_deg_ * 0.0174533f;

  uint32_t sum = 0;
  for (int i = 0; i < n; i++) {
    // LEDs assumed evenly spaced around the tile edge (radius ~0.45 tile).
    float a = 6.2831853f * i / n + rot;
    float x = cx + 0.45f * cosf(a), y = cy + 0.45f * sinf(a);
    Color c;
    switch (params_.effect) {
      case FX_RADIAL_WAVE: {
        float d = sqrtf(x * x + y * y);
        float ph = d / scale - t * spd;
        float w = 0.5f + 0.5f * sinf(6.2831853f * ph);
        c = hsv(params_.hue, params_.sat, (uint8_t) (params_.value * w));
        break;
      }
      case FX_RAINBOW_SWEEP: {
        float ph = x / scale - t * spd;
        ph -= floorf(ph);
        c = hsv((uint8_t) (params_.hue + ph * 255), params_.sat, params_.value);
        break;
      }
      case FX_PULSE: {
        float w = 0.5f + 0.5f * sinf(6.2831853f * t * spd);
        c = hsv(params_.hue, params_.sat, (uint8_t) (params_.value * w));
        break;
      }
      default:
        c = hsv(params_.hue, params_.sat, params_.value);
    }
    it[i] = c;
    sum += c.r + c.g + c.b;
  }
  // Current cap (ESTIMATED linear model): ma_led_ per LED at 255,255,255,
  // times the light's hard color_correct scale. Scale the frame down if over.
  float est = sum / 765.0f * ma_led_ * max_scale_;
  float k = 1.0f;
  if (est > budget_ma_) k = budget_ma_ / est;
  if (k < 1.0f) {
    for (int i = 0; i < n; i++) {
      Color c = it[i].get();
      it[i] = Color(c.r * k, c.g * k, c.b * k);
    }
  }
  last_ma_ = est * k;
}

void HexSync::dump_config() {
  ESP_LOGCONFIG(TAG, "HexSync tile %d at q=%d r=%d rot=%d", tile_id_, q_, r_, rot_deg_);
  ESP_LOGCONFIG(TAG, "  priority %d, static leader %d, beacon %ums, timeout %ums", priority_, static_leader_,
                beacon_ms_, timeout_ms_);
  ESP_LOGCONFIG(TAG, "  budget %d mA (model %.0f mA/LED x %.2f)", budget_ma_, ma_led_, max_scale_);
}

}  // namespace hexsync
}  // namespace esphome
