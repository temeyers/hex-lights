#include "hexsync.h"
#include "esphome/core/log.h"
#include "esphome/core/hal.h"
#include "esphome/components/wifi/wifi_component.h"
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <driver/gpio.h>
#include <rom/ets_sys.h>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <algorithm>

namespace esphome {
namespace hexsync {

static const char *const TAG = "hexsync";
static const uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
QueueHandle_t HexSync::queue_ = nullptr;

struct RxItem {
  uint8_t buf[HX_MAX_LEN];
  int16_t len;
  uint32_t t;
};

// ESP-IDF 5.x receive callback signature.
static void recv_cb_idf5(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  HexSync::on_recv_(info ? info->src_addr : nullptr, data, len);
}

void HexSync::on_recv_(const uint8_t *mac, const uint8_t *data, int len) {
  // Runs in the Wi-Fi task: only validate and enqueue.
  if (queue_ == nullptr || len < 4 || len > HX_MAX_LEN) return;
  uint16_t magic;
  memcpy(&magic, data, 2);
  if (magic != HX_MAGIC) return;
  if (data[2] != HX_VERSION) {
    static uint32_t last_log = 0;
    uint32_t now = millis();
    if (now - last_log > 30000) {  // wifi task: keep it rare
      last_log = now;
      ESP_LOGW("hexsync", "ignoring hexsync v%u packet (this firmware speaks v%u)", data[2], HX_VERSION);
    }
    return;
  }
  RxItem item;
  memcpy(item.buf, data, len);
  item.len = len;
  item.t = millis();
  xQueueSend(queue_, &item, 0);
}

void HexSync::setup() {
  queue_ = xQueueCreate(8, sizeof(RxItem));
  leader_id_ = 0;
  pref_ = global_preferences->make_preference<HxLayout>(0x48584C33UL ^ (uint32_t) tile_id_);  // "HXL3"
  seed_ = esp_random();
  params_.start_ms = 0;
  HxLayout l;
  if (pref_.load(&l)) {
    q_ = l.q; r_ = l.r; rot_deg_ = l.rotation; order_ = l.order; layout_gen_ = l.gen;
    if (l.led_count >= 1 && l.led_count <= HX_MAX_LEDS) led_count_ = l.led_count;
    params_.flags = (l.sync_mode & 1);  // default 0 = wireless; GPIO untouched unless 1
    ESP_LOGI(TAG, "layout from flash: q=%d r=%d rot=%d order=%d gen=%u sync=%s", q_, r_, rot_deg_, order_,
             layout_gen_, (params_.flags & 1) ? "jumper" : "wireless");
  }
  apply_sync_mode_();  // wireless: does nothing to the sync pin
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

uint32_t HexSync::effect_clock() const {
  // esp_timer µs base (same source as millis()) + coarse ESP-NOW offset + fine jumper phase.
  double ms = esp_timer_get_time() / 1000.0 + offset_ms_ + fine_ms_;
  return (uint32_t) (int64_t) floor(ms);
}

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
  p.palette = params_.palette;
  p.axis = params_.axis;
  p.start_ms = params_.start_ms;
  p.flags = params_.flags & 1;
  p.seed = seed_;
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
    params_.palette = p.palette < PAL_COUNT ? p.palette : 0;
    params_.axis = p.axis;
    params_.start_ms = p.start_ms;
    if ((p.flags & 1) != (params_.flags & 1)) {
      params_.flags = p.flags & 1;
      save_pending_ = true;  // every tile saves the mode it receives
      save_at_ = millis();
      apply_sync_mode_();
    }
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
  seed_ = p.seed;
  last_leader_rx_ = millis();

  // Clock sync. Air + stack latency only ever makes a sample *late*, so the
  // sample with the largest offset is the best one. Track it, but let it
  // decay slowly (1 ms per beacon) so crystal drift (~tens of ppm) is followed.
  int32_t sample = (int32_t)(p.clock_ms - rx_local) + 1;  // +1 ms ESTIMATED airtime
  if (pulse_lock_ && !is_leader()) {
    // Jumper owns the phase; ESP-NOW only carries the coarse ms count.
    float total = offset_ms_ + fine_ms_;
    if (fabsf(sample - total) > 50) { offset_ms_ = sample; fine_ms_ = 0; }
    return;
  }
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
  while (xQueueReceive(queue_, &item, 0) == pdTRUE) dispatch_(item.buf, item.len, item.t);

  uint32_t now_ms = millis();
  if (save_pending_ && now_ms - save_at_ > 1000) {  // debounce flash writes
    HxLayout l{(int8_t) q_, (int8_t) r_, (uint16_t) rot_deg_, (uint8_t) order_, layout_gen_, (uint8_t) led_count_,
                (uint8_t) (params_.flags & 1)};
    pref_.save(&l);
    global_preferences->sync();
    save_pending_ = false;
    ESP_LOGI(TAG, "layout saved q=%d r=%d rot=%d order=%d", q_, r_, rot_deg_, order_);
  }
  if (status_pending_ || now_ms - last_status_ > 2000 + (tile_id_ * 37) % 200) {
    status_pending_ = false;
    last_status_ = now_ms;
    send_status_();
  }
  // forget peers not heard for 10 s
  for (size_t i = 0; i < peers_.size();) {
    if (now_ms - peers_[i].last_seen > 10000) peers_.erase(peers_.begin() + i); else i++;
  }

  // ---- jumper sync line ----
  if (line_on_) {
    if (edge_new_) { edge_new_ = false; process_edge_(); }
    int64_t now_us = esp_timer_get_time();
    if (pulse_lock_ && !is_leader() && now_us - last_edge_us_ > 1000000) {  // 1 s ESTIMATED
      ESP_LOGW(TAG, "sync pulses lost -> ESP-NOW clock");
      pulse_lock_ = false;
      int32_t whole = (int32_t) lroundf(fine_ms_);
      offset_ms_ += whole;
      fine_ms_ = 0;
    }
  }

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

// ================= jumper sync line =================
// Only touched in jumper mode. In wireless mode the pin is never configured.
void IRAM_ATTR HexSync::sync_isr_(void *arg) {
  auto *self = (HexSync *) arg;
  int64_t t = esp_timer_get_time();
  if (t - self->edge_us_ < 50000) return;  // debounce: >= 50 ms between frames
  self->edge_us_ = t;
  self->edge_new_ = true;
}

void HexSync::pulse_timer_cb_(void *arg) {
  auto *self = (HexSync *) arg;
  if (!self->line_on_) return;
  if (self->is_leader()) {
    // open-drain: pull low ~50 µs, then release (the pull-up brings it back)
    gpio_set_level((gpio_num_t) self->sync_pin_, 0);
    ets_delay_us(50);
    gpio_set_level((gpio_num_t) self->sync_pin_, 1);
  }
  self->schedule_pulse_();
}

void HexSync::schedule_pulse_() {
  if (pulse_timer_ == nullptr) return;
  // next effect-clock boundary where clock_ms % 100 == 0
  double ms = esp_timer_get_time() / 1000.0 + offset_ms_ + fine_ms_;
  double next = (floor(ms / 100.0) + 1) * 100.0;
  int64_t wait_us = (int64_t) ((next - ms) * 1000.0);
  if (wait_us < 1000) wait_us += 100000;
  esp_timer_stop((esp_timer_handle_t) pulse_timer_);
  esp_timer_start_once((esp_timer_handle_t) pulse_timer_, wait_us);
}

void HexSync::line_enable_() {
  if (line_on_) return;
  gpio_num_t pin = (gpio_num_t) sync_pin_;
  gpio_config_t cfg{};
  cfg.pin_bit_mask = 1ULL << sync_pin_;
  cfg.mode = GPIO_MODE_INPUT_OUTPUT_OD;  // only ever pulls low; leader + followers share it
  cfg.pull_up_en = GPIO_PULLUP_ENABLE;   // internal ~45 kΩ [EST]; add 4.7 kΩ external for long lines
  cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
  cfg.intr_type = GPIO_INTR_NEGEDGE;
  gpio_config(&cfg);
  gpio_set_level(pin, 1);  // released
  gpio_install_isr_service(0);  // ESP_ERR_INVALID_STATE if already installed: fine
  gpio_isr_handler_add(pin, sync_isr_, this);
  if (pulse_timer_ == nullptr) {
    esp_timer_create_args_t a{};
    a.callback = pulse_timer_cb_;
    a.arg = this;
    a.name = "hexsync_pulse";
    esp_timer_handle_t h;
    if (esp_timer_create(&a, &h) == ESP_OK) pulse_timer_ = h;
  }
  line_on_ = true;
  last_edge_us_ = esp_timer_get_time();
  pulse_lock_ = false;
  schedule_pulse_();
  ESP_LOGI(TAG, "jumper sync ON (GPIO%d, open-drain)", sync_pin_);
}

void HexSync::line_disable_() {
  if (!line_on_) return;
  line_on_ = false;
  if (pulse_timer_ != nullptr) esp_timer_stop((esp_timer_handle_t) pulse_timer_);
  gpio_num_t pin = (gpio_num_t) sync_pin_;
  gpio_intr_disable(pin);
  gpio_isr_handler_remove(pin);
  // release: no output, no pulls, no interrupt (high-Z)
  gpio_set_direction(pin, GPIO_MODE_DISABLE);
  gpio_set_pull_mode(pin, GPIO_FLOATING);
  if (pulse_lock_) {
    offset_ms_ += (int32_t) lroundf(fine_ms_);
    fine_ms_ = 0;
    pulse_lock_ = false;
  }
  ESP_LOGI(TAG, "jumper sync OFF (GPIO%d released)", sync_pin_);
}

void HexSync::apply_sync_mode_() {
  if (params_.flags & 1) line_enable_(); else line_disable_();
}

void HexSync::set_sync_mode(int m) {
  params_.flags = (params_.flags & ~1) | (m & 1);
  uint32_t now = effect_clock();
  params_.gen = (now > params_.gen) ? now : params_.gen + 1;
  save_pending_ = true;
  save_at_ = millis();
  apply_sync_mode_();
  for (int i = 0; i < 3; i++) send_(HX_SET);
}

const char *HexSync::sync_source() const {
  if (!(params_.flags & 1)) return "espnow";
  if (is_leader()) return "jumper";  // leader drives the line
  return pulse_lock_ ? "jumper" : "jumper-lost";
}

void HexSync::process_edge_() {
  int64_t t = edge_us_;
  last_edge_us_ = t;
  if (is_leader()) return;  // our own pulse
  // effect clock at the edge; it should be on a 100 ms boundary
  double e = t / 1000.0 + offset_ms_ + fine_ms_;
  double err = e - round(e / 100.0) * 100.0;  // -50..+50 ms
  if (!pulse_lock_) {
    fine_ms_ -= err;  // snap
    pulse_lock_ = true;
    jitter_us_ = 0;
    ESP_LOGI(TAG, "sync pulses locked (step %.2f ms)", -err);
  } else {
    fine_ms_ -= 0.2f * err;  // smoothing
    jitter_us_ = 0.9f * jitter_us_ + 0.1f * fabsf(err * 1000.0f);
  }
  if (fabsf(fine_ms_) > 1000) {  // keep fine small
    int32_t whole = (int32_t) lroundf(fine_ms_);
    offset_ms_ += whole;
    fine_ms_ -= whole;
  }
}

void HexSync::dispatch_(const uint8_t *buf, int len, uint32_t t) {
  switch (buf[3]) {
    case HX_BEACON:
    case HX_SET:
      if (len == (int) sizeof(HxPacket)) {
        HxPacket p;
        memcpy(&p, buf, sizeof(p));
        handle_(p, t);
      }
      break;
    case HX_LAYOUT:
      if (len >= HX_LAYOUT_HDR && len <= (int) sizeof(HxLayoutPacket)) {
        HxLayoutPacket p{};
        memcpy(&p, buf, len);
        handle_layout_(p, len);
      }
      break;
    case HX_STATUS:
      if (len == (int) sizeof(HxStatusPacket)) {
        HxStatusPacket p;
        memcpy(&p, buf, sizeof(p));
        handle_status_(p);
      }
      break;
    default:
      break;
  }
}

void HexSync::layout_changed_(uint32_t gen) {
  if (gen != 0) layout_gen_ = gen;
  save_pending_ = true;
  save_at_ = millis();
  status_pending_ = true;  // ack quickly
}

void HexSync::apply_layout_(const HxLayoutEntry &e, uint32_t gen) {
  if (e.tile_id != tile_id_) return;
  bool same = e.q == q_ && e.r == r_ && (e.rotation % 360) == rot_deg_ && e.order == order_;
  q_ = e.q; r_ = e.r; rot_deg_ = e.rotation % 360; order_ = e.order;
  if (!same || gen != layout_gen_) {
    ESP_LOGI(TAG, "layout set: q=%d r=%d rot=%d order=%d (gen %u)", q_, r_, rot_deg_, order_, gen);
    layout_changed_(gen);
  } else {
    status_pending_ = true;
  }
}

void HexSync::handle_layout_(const HxLayoutPacket &p, int len) {
  int n = p.count;
  if (n > HX_LAYOUT_MAX || len < HX_LAYOUT_HDR + n * (int) sizeof(HxLayoutEntry)) return;
  for (int i = 0; i < n; i++) apply_layout_(p.e[i], p.gen);
}

void HexSync::send_layout_(const std::vector<HxLayoutEntry> &v) {
  uint32_t gen = effect_clock();
  if (gen == 0) gen = 1;
  for (size_t off = 0; off < v.size(); off += HX_LAYOUT_MAX) {
    HxLayoutPacket p{};
    p.magic = HX_MAGIC;
    p.version = HX_VERSION;
    p.type = HX_LAYOUT;
    p.sender = tile_id_;
    p.gen = gen;
    int n = std::min<int>(HX_LAYOUT_MAX, v.size() - off);
    p.count = n;
    for (int i = 0; i < n; i++) {
      p.e[i] = v[off + i];
      apply_layout_(p.e[i], gen);  // our own entry
    }
    int len = HX_LAYOUT_HDR + n * sizeof(HxLayoutEntry);
    for (int k = 0; k < 3; k++) {  // burst: broadcast has no retries
      p.seq = ++seq_;
      if (espnow_ok_) esp_now_send(BCAST, (const uint8_t *) &p, len);
    }
  }
}

void HexSync::send_tile_layout(int tile_id, int q, int r, int rotation, int order) {
  HxLayoutEntry e{(uint8_t) tile_id, (int8_t) q, (int8_t) r, (uint16_t) (((rotation % 360) + 360) % 360), (uint8_t) order};
  send_layout_({e});
}

int HexSync::send_layout_bulk(const std::string &s) {
  std::vector<HxLayoutEntry> v;
  size_t pos = 0;
  while (pos < s.size()) {
    size_t end = s.find(';', pos);
    if (end == std::string::npos) end = s.size();
    std::string item = s.substr(pos, end - pos);
    pos = end + 1;
    if (item.find_first_not_of(" \t\r\n") == std::string::npos) continue;
    int id, q, r, rot, ord;
    if (sscanf(item.c_str(), " %d:%d:%d:%d:%d", &id, &q, &r, &rot, &ord) != 5) {
      ESP_LOGW(TAG, "bad layout entry '%s'", item.c_str());
      return -1;
    }
    if (id < 1 || id > 250 || q < -50 || q > 50 || r < -50 || r > 50 || ord < 0 || ord > 254) return -1;
    v.push_back({(uint8_t) id, (int8_t) q, (int8_t) r, (uint16_t) (((rot % 360) + 360) % 360), (uint8_t) ord});
  }
  if (!v.empty()) send_layout_(v);
  return v.size();
}

void HexSync::send_status_() {
  if (!espnow_ok_) return;
  HxStatusPacket p{};
  p.magic = HX_MAGIC;
  p.version = HX_VERSION;
  p.type = HX_STATUS;
  p.sender = tile_id_;
  p.q = q_;
  p.r = r_;
  p.order = order_;
  p.rotation = rot_deg_;
  p.seq = ++seq_;
  p.layout_gen = layout_gen_;
  p.leader = leader_id_;
  p.neighbors = neighbor_count();
  p.reserved[0] = (uint8_t) led_count_;  // v2: LED count (ack)
  esp_now_send(BCAST, (const uint8_t *) &p, sizeof(p));
}

HxPeer *HexSync::peer_(uint8_t id) {
  for (auto &p : peers_) if (p.id == id) return &p;
  return nullptr;
}

void HexSync::handle_status_(const HxStatusPacket &s) {
  if (s.sender == tile_id_) return;
  HxPeer *p = peer_(s.sender);
  if (p == nullptr) {
    peers_.push_back({});
    p = &peers_.back();
    p->id = s.sender;
  }
  p->q = s.q; p->r = s.r; p->rotation = s.rotation; p->order = s.order;
  p->layout_gen = s.layout_gen;
  p->last_seen = millis();
}

// Neighbors from LIVE positions: the 6 axial directions.
static const int8_t DIRS[6][2] = {{1, 0}, {1, -1}, {0, -1}, {-1, 0}, {-1, 1}, {0, 1}};

int HexSync::neighbor_count() const {
  int n = 0;
  for (auto &p : peers_)
    for (auto &d : DIRS)
      if (p.q == q_ + d[0] && p.r == r_ + d[1]) { n++; break; }
  return n;
}

std::string HexSync::neighbor_list() const {
  std::string out;
  for (auto &d : DIRS)
    for (auto &p : peers_)
      if (p.q == q_ + d[0] && p.r == r_ + d[1]) {
        if (!out.empty()) out += ",";
        out += std::to_string(p.id);
      }
  return out;
}

std::string HexSync::layout_string() const {
  char b[40];
  snprintf(b, sizeof(b), "%d:%d:%d:%d:%d", tile_id_, q_, r_, rot_deg_, order_);
  return b;
}

// ---------------- wall controls ----------------
static const char *const FX_NAMES[FX_COUNT] = {"solid", "radial_wave", "rainbow_sweep", "pulse", "chase", "wipe",
                                               "rainbow_flow", "random_ripple", "twinkle", "color_cycle", "snake"};
static const char *const PAL_NAMES[PAL_COUNT] = {"rainbow", "ocean", "sunset", "forest", "fire", "mono"};

const char *HexSync::effect_name(int id) { return (id >= 0 && id < FX_COUNT) ? FX_NAMES[id] : "solid"; }
int HexSync::effect_id(const std::string &n) {
  for (int i = 0; i < FX_COUNT; i++) if (n == FX_NAMES[i]) return i;
  return -1;
}
const char *HexSync::palette_name(int id) { return (id >= 0 && id < PAL_COUNT) ? PAL_NAMES[id] : "rainbow"; }
int HexSync::palette_id(const std::string &n) {
  for (int i = 0; i < PAL_COUNT; i++) if (n == PAL_NAMES[i]) return i;
  return -1;
}

void HexSync::set_wall_fx(int effect, int palette, int speed, int scale, int hue, int sat, int value,
                          int start_delay_ms, int axis) {
  if (axis >= 0) params_.axis = (uint8_t) (axis & 3);
  uint32_t now = effect_clock();
  params_.gen = (now > params_.gen) ? now : params_.gen + 1;
  params_.effect = (effect >= 0 && effect < FX_COUNT) ? effect : FX_SOLID;
  params_.palette = (palette >= 0 && palette < PAL_COUNT) ? palette : PAL_RAINBOW;
  params_.speed = (uint16_t) std::max(0, std::min(65535, speed));
  params_.scale = (uint16_t) std::max(1, std::min(65535, scale));
  params_.hue = (uint8_t) std::max(0, std::min(255, hue));
  params_.sat = (uint8_t) std::max(0, std::min(255, sat));
  params_.value = (uint8_t) std::max(0, std::min(255, value));
  params_.start_ms = now + (uint32_t) std::max(0, std::min(10000, start_delay_ms));
  for (int i = 0; i < 3; i++) send_(HX_SET);  // burst: broadcast has no retries
  ESP_LOGI(TAG, "wall fx %s pal %s speed %u scale %u start +%d ms", effect_name(params_.effect),
           palette_name(params_.palette), params_.speed, params_.scale, start_delay_ms);
}

// Legacy v1 action path (set_wall_effect): keeps palette/axis, starts now.
void HexSync::set_effect(int effect, int hue, int sat, int value, int speed, int scale) {
  set_wall_fx(effect, params_.palette, speed, scale, hue, sat, value, 0);
}
void HexSync::set_wall_speed(int v) {
  set_wall_fx(params_.effect, params_.palette, v, params_.scale, params_.hue, params_.sat, params_.value, 0);
}
void HexSync::set_wall_palette(int v) {
  // keep phase: don't restart the effect
  uint32_t st = params_.start_ms;
  set_wall_fx(params_.effect, v, params_.speed, params_.scale, params_.hue, params_.sat, params_.value, 0);
  params_.start_ms = st;
  send_(HX_SET);
}
void HexSync::set_wall_effect_id(int v) {
  set_wall_fx(v, params_.palette, params_.speed, params_.scale, params_.hue, params_.sat, params_.value, 300);
}
void HexSync::set_wall_axis(int v) {
  params_.axis = (uint8_t) (v & 3);
  set_wall_fx(params_.effect, params_.palette, params_.speed, params_.scale, params_.hue, params_.sat, params_.value, 0);
}

// ---------------- colour helpers (mirror tools/effects-ref.js) ----------------
static inline float frac(float x) { return x - floorf(x); }

static Color hsvf(float hdeg, float s, float v) {  // h in degrees, s,v 0..1
  hdeg = frac(hdeg / 360.0f) * 6.0f;
  int i = (int) hdeg;
  float f = hdeg - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  float r, g, b;
  switch (i) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return Color(lroundf(r * 255), lroundf(g * 255), lroundf(b * 255));
}

// effects.json palette stops (evenly spaced at k/(n-1), linear, rounded).
static const uint8_t STOPS[5][4][3] = {
    {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}, {0, 0, 0}},  // rainbow (hsv)
    {{0, 40, 120}, {0, 160, 200}, {40, 220, 180}, {0, 40, 120}},
    {{255, 60, 0}, {255, 0, 80}, {120, 0, 160}, {255, 60, 0}},
    {{10, 80, 10}, {60, 180, 20}, {180, 220, 40}, {10, 80, 10}},
    {{120, 0, 0}, {255, 60, 0}, {255, 180, 20}, {120, 0, 0}},
};

static Color pal(int id, float u, uint8_t hue, uint8_t sat) {
  u = frac(u);
  if (id == PAL_RAINBOW) return hsvf(u * 360.0f, 1, 1);
  if (id == PAL_MONO || id < 0 || id >= PAL_COUNT) return hsvf(hue * 360.0f / 255.0f, sat / 255.0f, 1);
  float seg = u * 3.0f;  // n-1 = 3
  int i = std::min(2, (int) seg);
  float f = seg - i;
  const uint8_t *a = STOPS[id][i], *b = STOPS[id][i + 1];
  return Color(lroundf(a[0] + (b[0] - a[0]) * f), lroundf(a[1] + (b[1] - a[1]) * f),
               lroundf(a[2] + (b[2] - a[2]) * f));
}

static inline Color scale_c(Color c, float k) {
  if (k < 0) k = 0;
  if (k > 1) k = 1;
  return Color(lroundf(c.r * k), lroundf(c.g * k), lroundf(c.b * k));
}

// effects.json hash01: 32-bit unsigned wrap.
static inline float hash01(uint32_t a, uint32_t b) {
  return (float) (((a * 73856093u) ^ (b * 19349663u)) % 1000003u) / 1000003.0f;
}

static inline int hexdist(int q1, int r1, int q2, int r2) {
  int dq = q1 - q2, dr = r1 - r2;
  return (abs(dq) + abs(dr) + abs(dq + dr)) / 2;
}

Color HexSync::pixel_(int led, int n, float t_s, int index, int count, float xn, float yn, int ring, int max_ring,
                      float angle, int origin_d, int max_d, int head_d) {
  const HxParams &P = params_;
  const float spd = P.speed / 1000.0f;
  const float sc = P.scale / 100.0f;
  const int pid = P.palette;
  Color c(0, 0, 0);
  switch (P.effect) {
    case FX_SOLID:
      c = pal(PAL_MONO, 0, P.hue, P.sat);
      break;
    case FX_RADIAL_WAVE: {  // effects.json "ripple" from the master (0,0)
      float per = max_ring + 2;
      float ph = fmodf(t_s * spd, per);
      float k = std::max(0.0f, 1.0f - fabsf(ph - ring));
      c = scale_c(pal(pid, (float) ring / std::max(1, max_ring), P.hue, P.sat), k);
      break;
    }
    case FX_RAINBOW_SWEEP: {
      float u = (P.axis == AX_Y ? yn : P.axis == AX_RING ? (float) ring / std::max(1, max_ring)
                 : P.axis == AX_ANGLE ? angle / 360.0f : xn) + t_s * spd;
      c = pal(pid, u, P.hue, P.sat);
      break;
    }
    case FX_PULSE: {  // effects.json "breathe"
      float k = 0.5f - 0.5f * cosf(6.2831853f * t_s * spd);
      c = scale_c(pal(pid, 0, P.hue, P.sat), k);
      break;
    }
    case FX_CHASE:
    case FX_SNAKE: {
      float head = fmodf(t_s * spd, (float) count);
      float d = fmodf(head - index + count, (float) count);
      float k = std::max(0.0f, 1.0f - d / std::max(1.0f, sc));
      if (P.effect == FX_SNAKE && k <= 0 && head_d == 1) k = 0.25f;  // live neighbours of the head glow
      c = scale_c(pal(pid, (float) index / count, P.hue, P.sat), k);
      break;
    }
    case FX_WIPE: {
      float u = P.axis == AX_Y ? yn : P.axis == AX_RING ? (float) ring / std::max(1, max_ring)
                : P.axis == AX_ANGLE ? angle / 360.0f : xn;
      float ph = fmodf(t_s * spd, 2.0f);
      bool on = ph < 1 ? u <= ph : u > ph - 1;
      c = on ? pal(pid, u, P.hue, P.sat) : Color(0, 0, 0);
      break;
    }
    case FX_RAINBOW_FLOW:
      c = pal(pid, ((xn + yn) / 2.0f) * sc - t_s * spd, P.hue, P.sat);
      break;
    case FX_RIPPLE: {
      float per = max_d + 2;
      float ph = fmodf(t_s * spd, per);
      float k = std::max(0.0f, 1.0f - fabsf(ph - origin_d));
      c = scale_c(pal(pid, (float) origin_d / std::max(1, max_d), P.hue, P.sat), k);
      break;
    }
    case FX_TWINKLE: {
      uint32_t g = (uint32_t) index * 64u + (uint32_t) led;
      float u = t_s * spd + hash01(g, seed_ & 0xffffu);
      uint32_t slot = (uint32_t) floorf(u);
      float f = u - slot;
      float density = std::min(1.0f, sc / 10.0f);  // scale 150 -> 0.15
      bool on = hash01(g, slot + (seed_ & 0xffffu)) < density;
      c = on ? scale_c(pal(pid, hash01(slot, g), P.hue, P.sat), sinf(3.14159265f * f)) : Color(0, 0, 0);
      break;
    }
    case FX_COLOR_CYCLE:
      c = pal(pid, (float) index / count + t_s * spd, P.hue, P.sat);
      break;
    default:
      break;
  }
  return scale_c(c, P.value / 255.0f);
}

void HexSync::render(light::AddressableLight &it) {
  const int size = it.size();
  const int n = std::min(led_count_, size);
  // Live wall geometry: this tile + peers heard in the last 10 s.
  struct T { int id, q, r, order; };
  T tiles[64];
  int nt = 0;
  tiles[nt++] = {tile_id_, q_, r_, order_};
  for (auto &p : peers_) if (nt < 64) tiles[nt++] = {p.id, p.q, p.r, p.order};
  // sort by tile_id (ripple origin pick must be identical on every tile)
  std::sort(tiles, tiles + nt, [](const T &a, const T &b) { return a.id < b.id; });
  float minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  int max_ring = 0, max_order = 0, diam = 0;
  for (int i = 0; i < nt; i++) {
    float x = 1.7320508f * (tiles[i].q + tiles[i].r / 2.0f), y = 1.5f * tiles[i].r;
    minx = std::min(minx, x); maxx = std::max(maxx, x);
    miny = std::min(miny, y); maxy = std::max(maxy, y);
    max_ring = std::max(max_ring, hexdist(tiles[i].q, tiles[i].r, 0, 0));
    max_order = std::max(max_order, tiles[i].order);
    for (int j = i + 1; j < nt; j++) diam = std::max(diam, hexdist(tiles[i].q, tiles[i].r, tiles[j].q, tiles[j].r));
  }
  const int count = std::max(nt, max_order + 1);
  float cx = 1.7320508f * (q_ + r_ / 2.0f), cy = 1.5f * r_;
  float xn = maxx > minx ? (cx - minx) / (maxx - minx) : 0.5f;
  float yn = maxy > miny ? (cy - miny) / (maxy - miny) : 0.5f;
  int ring = hexdist(q_, r_, 0, 0);
  float angle = atan2f(cy, cx) * 57.29578f;  // screen y down -> clockwise
  if (angle < 0) angle += 360.0f;

  int32_t tms = (int32_t) (effect_clock() - params_.start_ms);
  if (tms < 0) tms = 0;  // before a delayed start: hold frame 0
  const float t_s = tms / 1000.0f;
  const float spd = params_.speed / 1000.0f;

  // random_ripple: origin for cycle k = tiles[hash(seed,k) % nt]
  int origin_d = 0, max_d = 0;
  if (params_.effect == FX_RIPPLE) {
    float per = diam + 2;
    uint32_t k = (uint32_t) floorf(t_s * spd / per);
    int oi = (int) (hash01(seed_, k) * nt) % nt;
    origin_d = hexdist(q_, r_, tiles[oi].q, tiles[oi].r);
    for (int i = 0; i < nt; i++) max_d = std::max(max_d, hexdist(tiles[oi].q, tiles[oi].r, tiles[i].q, tiles[i].r));
    // phase within this ripple's period, so the ring restarts at each new origin
    // (pixel_ uses fmod(t*spd, max_d+2); feed it the time since this cycle began)
  }
  int head_d = 99;
  if (params_.effect == FX_SNAKE) {
    int head = (int) floorf(fmodf(t_s * spd, (float) count));
    for (int i = 0; i < nt; i++)
      if (tiles[i].order == head) head_d = hexdist(q_, r_, tiles[i].q, tiles[i].r);
  }
  float t_eff = t_s;
  if (params_.effect == FX_RIPPLE && spd > 0) {
    float per = diam + 2;
    float cyc = t_s * spd / per;
    t_eff = (cyc - floorf(cyc)) * per / spd;  // time since this ripple started
  }

  uint32_t sum = 0;
  for (int i = 0; i < size; i++) {
    Color c = i < n ? pixel_(i, n, t_eff, order_, count, xn, yn, ring, max_ring, angle, origin_d, max_d, head_d)
                    : Color(0, 0, 0);  // pixels beyond LED count stay black
    it[i] = c;
    sum += c.r + c.g + c.b;
  }
  // Current cap (ESTIMATED linear model) over the N active LEDs.
  float est = sum / 765.0f * ma_led_ * max_scale_;
  float k = est > budget_ma_ ? budget_ma_ / est : 1.0f;
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
