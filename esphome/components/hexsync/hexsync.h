#pragma once
#include "esphome/core/component.h"
#include "esphome/core/preferences.h"
#include <string>
#include <vector>
#include "esphome/components/light/addressable_light.h"
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <cstdint>

namespace esphome {
namespace hexsync {

// ---- Wire format v2 (little-endian, packed). HxPacket = 36 bytes ----
// Every packet is a full state snapshot, so a lost packet costs nothing:
// the next beacon (default every 100 ms) repairs it.
static const uint16_t HX_MAGIC = 0x5848;  // "HX"
static const uint8_t HX_VERSION = 2;  // v1 packets are ignored (logged)
enum HxType : uint8_t { HX_BEACON = 1, HX_SET = 2, HX_LAYOUT = 3, HX_STATUS = 4 };
static const int HX_MAX_LEN = 250;  // ESP-NOW v1 payload limit
// Ids 0-6 match Back End effects.json / tools/gen_ha.py WALL_FX.
enum HxEffect : uint8_t {
  FX_SOLID = 0, FX_RADIAL_WAVE = 1, FX_RAINBOW_SWEEP = 2, FX_PULSE = 3, FX_CHASE = 4,
  FX_WIPE = 5, FX_RAINBOW_FLOW = 6, FX_RIPPLE = 7, FX_TWINKLE = 8, FX_COLOR_CYCLE = 9, FX_SNAKE = 10,
  FX_COUNT = 11
};
enum HxPalette : uint8_t { PAL_RAINBOW = 0, PAL_OCEAN = 1, PAL_SUNSET = 2, PAL_FOREST = 3, PAL_FIRE = 4, PAL_MONO = 5, PAL_COUNT = 6 };
enum HxAxis : uint8_t { AX_X = 0, AX_Y = 1, AX_RING = 2, AX_ANGLE = 3 };
static const int HX_MAX_LEDS = 60;

struct __attribute__((packed)) HxPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;
  uint8_t sender;      // tile_id of sender
  uint8_t priority;    // sender's leader priority (lower wins)
  uint16_t seq;        // per-sender sequence, wraps; drops dupes/out-of-order
  uint32_t clock_ms;   // leader's effect clock at send time
  uint32_t gen;        // parameter generation; higher replaces lower
  uint8_t effect;
  uint8_t hue;         // 0..255
  uint8_t sat;         // 0..255
  uint8_t value;       // 0..255 effect brightness (before current cap)
  uint16_t speed;      // effect-specific, ~"milli-cycles per second"
  uint16_t scale;      // spatial scale x100 (tiles per cycle)
  uint8_t channel;     // sender's Wi-Fi channel (diagnostic / mismatch check)
  uint8_t palette;     // v2: HxPalette
  uint8_t axis;        // v2: wipe axis HxAxis
  uint8_t flags;       // v2: bit0 = sync mode jumper (1) / wireless (0); bits1-7 reserved 0
  uint32_t start_ms;   // v2: effect phase origin on the shared clock; t = clock - start_ms
  uint32_t seed;       // v2: leader random seed (ripple origin, twinkle)
};
static_assert(sizeof(HxPacket) == 36, "HxPacket size");

// Layout entry, 6 bytes. rotation in degrees 0..359, order = chase index 0..254.
struct __attribute__((packed)) HxLayoutEntry {
  uint8_t tile_id;
  int8_t q;
  int8_t r;
  uint16_t rotation;
  uint8_t order;
};
// HX_LAYOUT: 12-byte header + count*6 bytes (count <= 39 -> 246 bytes).
struct __attribute__((packed)) HxLayoutPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;      // HX_LAYOUT
  uint8_t sender;
  uint8_t count;
  uint16_t seq;
  uint32_t gen;      // layout generation (sender effect clock ms)
  HxLayoutEntry e[39];
};
static const int HX_LAYOUT_HDR = 12;
static const int HX_LAYOUT_MAX = 39;
// HX_STATUS: every tile, every 2 s and right after a layout change (= the ack).
struct __attribute__((packed)) HxStatusPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;      // HX_STATUS
  uint8_t sender;    // tile_id
  int8_t q;
  int8_t r;
  uint8_t order;
  uint16_t rotation;
  uint16_t seq;
  uint32_t layout_gen;  // gen of the last layout applied (0 = compile/number defaults)
  uint8_t leader;
  uint8_t neighbors;    // live neighbor count
  uint8_t reserved[2];  // v2: [0] = LED count
};
static_assert(sizeof(HxStatusPacket) == 20, "status size");

struct HxLayout {
  int8_t q, r;
  uint16_t rotation;
  uint8_t order;
  uint32_t gen;
  uint8_t led_count;
  uint8_t sync_mode;  // 0 wireless (ESP-NOW), 1 jumper wire
};

struct HxPeer {
  uint8_t id;
  int8_t q, r;
  uint16_t rotation;
  uint8_t order;
  uint32_t layout_gen;
  uint32_t last_seen;
};

struct HxParams {
  uint32_t gen{0};
  uint8_t effect{FX_RADIAL_WAVE};
  uint8_t hue{160}, sat{255}, value{180};
  uint16_t speed{500}, scale{300};
  uint8_t palette{PAL_RAINBOW}, axis{AX_X};
  uint32_t start_ms{0};
  uint8_t flags{0};  // bit0 jumper
};

class HexSync : public Component {
 public:
  void set_tile(int id, int q, int r, int rot, int order) {
    tile_id_ = id; q_ = q; r_ = r; rot_deg_ = rot; order_ = order;
  }
  // Runtime layout (HA number entities / layout packets). Saved to flash.
  void set_q(int v) { q_ = v; layout_changed_(0); }
  void set_r(int v) { r_ = v; layout_changed_(0); }
  void set_rotation(int v) { rot_deg_ = ((v % 360) + 360) % 360; layout_changed_(0); }
  void set_order(int v) { order_ = v; layout_changed_(0); }
  void set_led_count(int v) { led_count_ = v < 1 ? 1 : (v > HX_MAX_LEDS ? HX_MAX_LEDS : v); layout_changed_(0); }
  void set_default_led_count(int v) { led_count_ = v; }
  int led_count() const { return led_count_; }
  // v2 wall effect. start_delay_ms > 0 lets every tile receive it before it starts.
  void set_wall_fx(int effect, int palette, int speed, int scale, int hue, int sat, int value, int start_delay_ms,
                   int axis = -1);  // axis -1 = keep current
  // Change one shared control, keep the rest (Wall speed / palette / effect / axis entities).
  void set_wall_speed(int v);
  void set_wall_palette(int v);
  void set_wall_effect_id(int v);
  void set_wall_axis(int v);
  int wall_effect() const { return params_.effect; }
  int wall_palette() const { return params_.palette; }
  int wall_speed() const { return params_.speed; }
  int wall_axis() const { return params_.axis; }
  static const char *effect_name(int id);
  static int effect_id(const std::string &name);
  static const char *palette_name(int id);
  static int palette_id(const std::string &name);
  int q() const { return q_; }
  int r() const { return r_; }
  int rotation() const { return rot_deg_; }
  int order() const { return order_; }
  uint32_t layout_gen() const { return layout_gen_; }
  // Broadcast layout entries. Entries for this tile are applied locally too.
  void send_tile_layout(int tile_id, int q, int r, int rotation, int order);
  // "id:q:r:rot:order;id:q:r:rot:order;..." Returns entries parsed, -1 on error.
  int send_layout_bulk(const std::string &s);
  int neighbor_count() const;
  std::string neighbor_list() const;  // "2,3,7"
  std::string layout_string() const;  // this tile, same format as bulk entry
  int peer_count() const { return peers_.size(); }
  void set_priority(int p) { priority_ = p; }
  void set_static_leader(int id) { static_leader_ = id; }
  void set_budget(int ma, float ma_led, float max_scale) { budget_ma_ = ma; ma_led_ = ma_led; max_scale_ = max_scale; }
  // Runtime: HA "Max brightness" (0..1, also the light's correction) and "Current limit" switch (default off).
  void set_max_scale(float k) { max_scale_ = k < 0 ? 0 : (k > 1 ? 1 : k); }
  void set_budget_enabled(bool on) { budget_enabled_ = on; }
  bool budget_enabled() const { return budget_enabled_; }
  void set_timing(uint32_t beacon, uint32_t timeout) { beacon_ms_ = beacon; timeout_ms_ = timeout; }

  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  // Called from HA action (any tile). Becomes the newest generation wall-wide.
  void set_effect(int effect, int hue, int sat, int value, int speed, int scale);
  // Called from an addressable_lambda effect every frame.
  void render(light::AddressableLight &it);
  // Pure tile/LED colour, exposed so it can be unit-tested against tools/effects-ref.js.
  // Per-LED geometry: xn/yn/ringw/angle/od are for THIS LED (position on the tile's ring), so every
  // effect animates within a single tile, not just tile-to-tile.
  Color pixel_(int led, int n, float t_s, int index, int count, float xn, float yn, float ringw, float max_ringw,
               float angle, float od, float max_od, int head_d);

  bool is_leader() const { return leader_id_ == tile_id_; }
  int leader_id() const { return leader_id_; }
  uint32_t effect_clock() const;
  int32_t clock_offset() const { return offset_ms_; }
  // ---- sync line (jumper mode) ----
  void set_sync_pin(int pin) { sync_pin_ = pin; }
  // First-boot value only: setup() applies it, then a saved flash value overrides it.
  void set_sync_mode_default(int m) { params_.flags = (params_.flags & ~1) | (m & 1); }
  void set_sync_mode(int m);  // from the master's select; broadcast to all tiles
  int sync_mode() const { return params_.flags & 1; }
  const char *sync_source() const;  // "espnow" | "jumper" | "jumper-lost"
  float pulse_jitter_us() const { return jitter_us_; }
  float pulse_offset_ms() const { return fine_ms_; }
  static void IRAM_ATTR sync_isr_(void *arg);
  static void pulse_timer_cb_(void *arg);
  uint32_t rx_count() const { return rx_count_; }
  uint32_t drop_count() const { return drop_count_; }
  float last_est_ma() const { return last_ma_; }

 public:
  static void on_recv_(const uint8_t *mac, const uint8_t *data, int len);

 protected:
  void layout_changed_(uint32_t gen);
  void apply_layout_(const HxLayoutEntry &e, uint32_t gen);
  void send_layout_(const std::vector<HxLayoutEntry> &v);
  void send_status_();
  void handle_layout_(const HxLayoutPacket &p, int len);
  void handle_status_(const HxStatusPacket &p);
  HxPeer *peer_(uint8_t id);
  ESPPreferenceObject pref_;
  int order_{0};
  int led_count_{44};
  uint32_t seed_{0};
  uint32_t last_v1_log_{0};
  uint32_t layout_gen_{0};
  bool save_pending_{false};
  uint32_t save_at_{0};
  bool status_pending_{false};
  uint32_t last_status_{0};
  std::vector<HxPeer> peers_;
  bool init_espnow_();
  void send_(uint8_t type);
  void handle_(const HxPacket &p, uint32_t rx_local_ms);
  void dispatch_(const uint8_t *buf, int len, uint32_t t);
  bool i_should_lead_() const;

  static QueueHandle_t queue_;
  bool espnow_ok_{false};
  uint8_t channel_{0};

  int tile_id_{1}, q_{0}, r_{0}, rot_deg_{0};
  int priority_{1}, static_leader_{0};
  int budget_ma_{1500};
  float ma_led_{60.0f}, max_scale_{1.0f};
  bool budget_enabled_{false};
  uint32_t beacon_ms_{100}, timeout_ms_{1500};

  HxParams params_;
  int leader_id_{0};
  int leader_prio_{255};
  uint32_t last_leader_rx_{0};
  uint16_t last_leader_seq_{0};
  bool have_leader_seq_{false};
  int32_t offset_ms_{0};      // effect_clock = now_ms + offset_ms_ + fine_ms_
  float fine_ms_{0};           // jumper-mode sub-ms phase correction
  int sync_pin_{12};
  bool line_on_{false};        // pin configured (jumper mode only)
  bool pulse_lock_{false};     // followers: pulses seen in the last 1 s
  volatile int64_t edge_us_{0};
  volatile bool edge_new_{false};
  int64_t last_edge_us_{0};
  float jitter_us_{0};
  void *pulse_timer_{nullptr};
  void apply_sync_mode_();
  void line_enable_();
  void line_disable_();
  void schedule_pulse_();
  void process_edge_();
  bool offset_locked_{false};
  uint16_t seq_{0};
  uint32_t last_beacon_{0};
  uint32_t rx_count_{0}, drop_count_{0};
  float last_ma_{0};
};

}  // namespace hexsync
}  // namespace esphome
