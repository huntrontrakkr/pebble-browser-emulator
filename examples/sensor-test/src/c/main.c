// SPDX-License-Identifier: Apache-2.0
#include <pebble.h>
static Window *window;
static TextLayer *text;
static char display[220];
static int x, y, z, heading, calibration, tap_axis = -1, tap_direction;
static int touch_x, touch_y, touch_type = -1;
static int samples;
static int last_steps = -1, last_heart = -1;
static void refresh(void) {
  int steps = health_service_sum_today(HealthMetricStepCount);
  int heart = health_service_peek_current_value(HealthMetricHeartRateRawBPM);
  if (steps != last_steps || heart != last_heart) {
    APP_LOG(APP_LOG_LEVEL_INFO, "SENSOR values steps %d heart %d", steps, heart);
    last_steps = steps;last_heart = heart;
  }
  snprintf(display, sizeof(display), "Sensor Test\nX %d Y %d\nZ %d mg\nCompass %d / %d\nTap %d / %d\nSteps %d\nRaw HR %d BPM\nTouch %d %d,%d", x, y, z, heading, calibration, tap_axis, tap_direction, steps, heart, touch_type, touch_x, touch_y);
  text_layer_set_text(text, display);
}
static void on_accel(AccelData *data, uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {x = data[i].x; y = data[i].y; z = data[i].z;}
  samples += count;
  if (samples % 10 == 0) APP_LOG(APP_LOG_LEVEL_INFO, "SENSOR accel %d %d %d count %lu", x, y, z, (unsigned long)count);
  refresh();
}
static void on_tap(AccelAxisType axis, int32_t direction) {
  tap_axis = axis; tap_direction = direction;
  APP_LOG(APP_LOG_LEVEL_INFO, "SENSOR tap %d %ld", axis, (long)direction);
  refresh();
}
static void on_compass(CompassHeadingData data) {
  heading = data.magnetic_heading; calibration = data.compass_status;
  APP_LOG(APP_LOG_LEVEL_INFO, "SENSOR compass %d %d", heading, calibration);
  refresh();
}
static void on_health(HealthEventType event, void *context) {
  APP_LOG(APP_LOG_LEVEL_INFO, "SENSOR health %d", event);
  refresh();
}
#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_GABBRO)
static void on_touch(const TouchEvent *event, void *context) {
  touch_type = event->type; touch_x = event->x; touch_y = event->y;
  APP_LOG(APP_LOG_LEVEL_INFO, "SENSOR touch %d %d %d", touch_type, touch_x, touch_y);
  refresh();
}
#endif
static void select_click(ClickRecognizerRef recognizer, void *context) {vibes_short_pulse();}
static void clicks(void *context) {window_single_click_subscribe(BUTTON_ID_SELECT, select_click);}
static void inbox(DictionaryIterator *iterator, void *context) {refresh();}
static void load(Window *w) {
  Layer *root = window_get_root_layer(w);
  GRect frame = layer_get_bounds(root);
  text = text_layer_create(GRect(frame.size.w > 200 ? 35 : 4, frame.size.h > 240 ? 40 : 4, frame.size.w > 200 ? frame.size.w - 70 : frame.size.w - 8, frame.size.h - 8));
  text_layer_set_font(text, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_color(text, GColorBlack);text_layer_set_background_color(text, GColorWhite);
  layer_add_child(root, text_layer_get_layer(text));
  accel_data_service_subscribe(1, on_accel);accel_service_set_sampling_rate(ACCEL_SAMPLING_10HZ);
  accel_tap_service_subscribe(on_tap);compass_service_set_heading_filter(0);compass_service_subscribe(on_compass);
  health_service_events_subscribe(on_health, NULL);
#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_GABBRO)
  touch_service_subscribe(on_touch, NULL);
#endif
  app_message_register_inbox_received(inbox);app_message_open(256, 256);
  refresh();
}
static void unload(Window *w) {
  accel_data_service_unsubscribe();accel_tap_service_unsubscribe();compass_service_unsubscribe();health_service_events_unsubscribe();
#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_GABBRO)
  touch_service_unsubscribe();
#endif
  text_layer_destroy(text);
}
int main(void) {
  window = window_create();window_set_background_color(window, GColorWhite);
  window_set_window_handlers(window, (WindowHandlers){.load = load, .unload = unload});
  window_set_click_config_provider(window, clicks);window_stack_push(window, false);
  app_event_loop();window_destroy(window);
}
