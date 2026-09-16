#include <pebble.h>

static Window *s_window;
static TextLayer *s_time_layer, *s_status_layer, *s_device_layer;
static char s_time[8], s_status[64] = "Waiting for phone", s_device[48];

static void update_time(void) {
  time_t now = time(NULL);
  struct tm *local = localtime(&now);
  strftime(s_time, sizeof(s_time), clock_is_24h_style() ? "%H:%M" : "%I:%M", local);
  text_layer_set_text(s_time_layer, s_time);
}

static void update_device(void) {
  BatteryChargeState state = battery_state_service_peek();
  snprintf(s_device, sizeof(s_device), "%u%% battery  |  %s", state.charge_percent,
           connection_service_peek_pebble_app_connection() ? "Connected" : "Offline");
  text_layer_set_text(s_device_layer, s_device);
}

static void tick(struct tm *time, TimeUnits changed) { update_time(); }
static void battery_changed(BatteryChargeState state) { update_device(); }
static void connection_changed(bool connected) { update_device(); }
static void inbox(DictionaryIterator *iterator, void *context) {
  Tuple *status = dict_find(iterator, MESSAGE_KEY_status);
  if (status && status->type == TUPLE_CSTRING && status->length > 0) {
    size_t length = status->length - 1;
    if (length >= sizeof(s_status)) length = sizeof(s_status) - 1;
    memcpy(s_status, status->value->cstring, length);
    s_status[length] = '\0';
    text_layer_set_text(s_status_layer, s_status);
  }
}

static TextLayer *make_text(Layer *parent, GRect bounds, const char *font) {
  TextLayer *layer = text_layer_create(bounds);
  text_layer_set_background_color(layer, GColorClear);
  text_layer_set_text_color(layer, GColorWhite);
  text_layer_set_font(layer, fonts_get_system_font(font));
  text_layer_set_text_alignment(layer, GTextAlignmentCenter);
  layer_add_child(parent, text_layer_get_layer(layer));
  return layer;
}

static void load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  s_time_layer = make_text(root, GRect(0, 52, bounds.size.w, 58), FONT_KEY_BITHAM_42_BOLD);
  s_device_layer = make_text(root, GRect(4, 119, bounds.size.w - 8, 44), FONT_KEY_GOTHIC_18);
  s_status_layer = make_text(root, GRect(6, 169, bounds.size.w - 12, 44), FONT_KEY_GOTHIC_18);
  text_layer_set_text(s_status_layer, s_status);
  update_time(); update_device();
}
static void unload(Window *window) {
  text_layer_destroy(s_time_layer); text_layer_destroy(s_device_layer); text_layer_destroy(s_status_layer);
}
static void init(void) {
  s_window = window_create();
  window_set_background_color(s_window, GColorBlack);
  window_set_window_handlers(s_window, (WindowHandlers){.load=load, .unload=unload});
  window_stack_push(s_window, true);
  tick_timer_service_subscribe(MINUTE_UNIT, tick);
  battery_state_service_subscribe(battery_changed);
  connection_service_subscribe((ConnectionHandlers){.pebble_app_connection_handler=connection_changed});
  app_message_register_inbox_received(inbox);
  app_message_open(128, 128);
}
static void deinit(void) {
  app_message_deregister_callbacks(); tick_timer_service_unsubscribe();
  battery_state_service_unsubscribe(); connection_service_unsubscribe(); window_destroy(s_window);
}
int main(void) { init(); app_event_loop(); deinit(); }
