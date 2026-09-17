// SPDX-License-Identifier: Apache-2.0
#include <pebble.h>

static Window *window;
static TextLayer *time_layer, *date_layer, *battery_layer;
static char time_text[12], date_text[24], battery_text[24];
static bool dark_mode, show_date = true, show_battery = true;

static void apply_settings(void) {
  GColor foreground = dark_mode ? GColorWhite : GColorBlack;
  window_set_background_color(window, dark_mode ? GColorBlack : GColorWhite);
  text_layer_set_text_color(time_layer, foreground);
  text_layer_set_text_color(date_layer, foreground);
  text_layer_set_text_color(battery_layer, foreground);
  layer_set_hidden(text_layer_get_layer(date_layer), !show_date);
  layer_set_hidden(text_layer_get_layer(battery_layer), !show_battery);
}
static void received(DictionaryIterator *iterator, void *context) {
  (void)context;
  Tuple *dark = dict_find(iterator, MESSAGE_KEY_DARK_MODE);
  Tuple *date = dict_find(iterator, MESSAGE_KEY_SHOW_DATE);
  Tuple *battery = dict_find(iterator, MESSAGE_KEY_SHOW_BATTERY);
  if (dark) { dark_mode = dark->value->int32 != 0; persist_write_bool(0, dark_mode); }
  if (date) { show_date = date->value->int32 != 0; persist_write_bool(1, show_date); }
  if (battery) { show_battery = battery->value->int32 != 0; persist_write_bool(2, show_battery); }
  apply_settings();
  APP_LOG(APP_LOG_LEVEL_INFO, "Clock settings applied: %d %d %d", dark_mode, show_date, show_battery);
}

static void update_time(struct tm *now, TimeUnits changed) {
  (void)changed;
  strftime(time_text, sizeof(time_text), clock_is_24h_style() ? "%H:%M" : "%I:%M", now);
  strftime(date_text, sizeof(date_text), "%a, %b %e", now);
  text_layer_set_text(time_layer, time_text);
  text_layer_set_text(date_layer, date_text);
}
static void update_battery(BatteryChargeState state) {
  snprintf(battery_text, sizeof(battery_text), "%d%% battery", state.charge_percent);
  text_layer_set_text(battery_layer, battery_text);
}
static TextLayer *text(GRect bounds, const char *font) {
  TextLayer *layer = text_layer_create(bounds);
  text_layer_set_font(layer, fonts_get_system_font(font));
  text_layer_set_text_alignment(layer, GTextAlignmentCenter);
  text_layer_set_background_color(layer, GColorClear);
  text_layer_set_text_color(layer, GColorBlack);
  layer_add_child(window_get_root_layer(window), text_layer_get_layer(layer));
  return layer;
}
static void load(Window *unused) {
  (void)unused;
  GRect b = layer_get_bounds(window_get_root_layer(window));
  const int y = b.size.h / 2;
  time_layer = text(GRect(0, y - 46, b.size.w, 52), FONT_KEY_BITHAM_42_BOLD);
  date_layer = text(GRect(0, y + 9, b.size.w, 30), FONT_KEY_GOTHIC_24);
  battery_layer = text(GRect(0, y + 40, b.size.w, 24), FONT_KEY_GOTHIC_18);
  apply_settings();
  time_t epoch = time(NULL);
  update_time(localtime(&epoch), MINUTE_UNIT);
  update_battery(battery_state_service_peek());
  tick_timer_service_subscribe(MINUTE_UNIT, update_time);
  battery_state_service_subscribe(update_battery);
}
static void unload(Window *unused) {
  (void)unused;
  tick_timer_service_unsubscribe();
  battery_state_service_unsubscribe();
  text_layer_destroy(time_layer); text_layer_destroy(date_layer); text_layer_destroy(battery_layer);
}
int main(void) {
  if (persist_exists(0)) dark_mode = persist_read_bool(0);
  if (persist_exists(1)) show_date = persist_read_bool(1);
  if (persist_exists(2)) show_battery = persist_read_bool(2);
  app_message_register_inbox_received(received);
  app_message_open(128, 64);
  window = window_create();
  window_set_background_color(window, GColorWhite);
  window_set_window_handlers(window, (WindowHandlers){.load = load, .unload = unload});
  window_stack_push(window, false);
  app_event_loop();
  window_destroy(window);
}
