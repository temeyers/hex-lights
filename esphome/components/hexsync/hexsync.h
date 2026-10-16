#pragma once
#include "esphome/core/component.h"
#include "esphome/components/light/addressable_light.h"
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <cstdint>

namespace esphome {
namespace hexsync {

// ---- Wire format (little-endian, packed, 28 bytes) ----
// Every packet is a full state snapshot, so a lost packet costs nothing:
// the next beacon (default every 100 ms) repairs it.
static const uint16_t HX_MAGIC = 0x5848;  // "HX"
static const uint8_t HX_VERSION = 1;
enum HxType : uint8_t { HX_BEACON = 1, HX_SET = 2 };
enum HxEffect : uint8_t { FX_SOLID = 0, FX_RADIAL_WAVE = 1, FX_RAINBOW_SWEEP = 2, FX_PULSE = 3 };

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
  uint8_t reserved[3];
};
static_assert(sizeof(HxPacket) == 28, "HxPacket size");

struct HxParams {
  uint32_t gen{0};
  uint8_t effect{FX_RADIAL_WAVE};
  uint8_t hue{160}, sat{255}, value{180};
  uint16_t speed{500}, scale{300};
};

class HexSync : public Component {
 public:
  void set_tile(int id, int q, int r, int rot) { tile_id_ = id; q_ = q; r_ = r; rot_deg_ = rot; }
  void set_priority(int p) { priority_ = p; }
  void set_static_leader(int id) { static_leader_ = id; }
  void set_budget(int ma, float ma_led, float max_scale) { budget_ma_ = ma; ma_led_ = ma_led; max_scale_ = max_scale; }
  void set_timing(uint32_t beacon, uint32_t timeout) { beacon_ms_ = beacon; timeout_ms_ = timeout; }

  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  // Called from HA action (any tile). Becomes the newest generation wall-wide.
  void set_effect(int effect, int hue, int sat, int value, int speed, int scale);
  // Called from an addressable_lambda effect every frame.
  void render(light::AddressableLight &it);

  bool is_leader() const { return leader_id_ == tile_id_; }
  int leader_id() const { return leader_id_; }
  uint32_t effect_clock() const;
  int32_t clock_offset() const { return offset_ms_; }
  uint32_t rx_count() const { return rx_count_; }
  uint32_t drop_count() const { return drop_count_; }
  float last_est_ma() const { return last_ma_; }

 public:
  static void on_recv_(const uint8_t *mac, const uint8_t *data, int len);

 protected:
  bool init_espnow_();
  void send_(uint8_t type);
  void handle_(const HxPacket &p, uint32_t rx_local_ms);
  bool i_should_lead_() const;

  static QueueHandle_t queue_;
  bool espnow_ok_{false};
  uint8_t channel_{0};

  int tile_id_{1}, q_{0}, r_{0}, rot_deg_{0};
  int priority_{1}, static_leader_{0};
  int budget_ma_{1500};
  float ma_led_{60.0f}, max_scale_{1.0f};
  uint32_t beacon_ms_{100}, timeout_ms_{1500};

  HxParams params_;
  int leader_id_{0};
  int leader_prio_{255};
  uint32_t last_leader_rx_{0};
  uint16_t last_leader_seq_{0};
  bool have_leader_seq_{false};
  int32_t offset_ms_{0};      // effect_clock = millis() + offset_ms_
  bool offset_locked_{false};
  uint16_t seq_{0};
  uint32_t last_beacon_{0};
  uint32_t rx_count_{0}, drop_count_{0};
  float last_ma_{0};
};

}  // namespace hexsync
}  // namespace esphome
