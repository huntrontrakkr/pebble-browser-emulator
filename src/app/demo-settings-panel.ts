import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnInit,
  Output,
  ViewChild,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { defaultDemoSettings, normalizeDemoSettings, type DemoSettings } from './demo-settings.ts';
import { HEALTH_METRICS, type DeviceSignal } from './signals.ts';
import { WEATHER_CONDITIONS, type WeatherCondition } from './weather-records.ts';
import { coordinateName, fetchForecast } from './weather-source.ts';

@Component({
  selector: 'demo-settings-panel',
  imports: [FormsModule],
  templateUrl: './demo-settings-panel.html',
})
export class DemoSettingsPanel implements OnInit, AfterViewInit {
  @Input() settings = defaultDemoSettings();
  @Input() busy = false;
  @Input() ready = false;
  @Input() heartRateAvailable = false;
  @Input() status = '';
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<DemoSettings>();
  @Output() notification = new EventEmitter<{ settings: DemoSettings; id: number }>();
  @Output() signalSent = new EventEmitter<DeviceSignal>();
  @ViewChild('dialog') dialog!: ElementRef<HTMLDialogElement>;
  draft = defaultDemoSettings();
  error = signal('');
  metrics = HEALTH_METRICS;
  conditions = Object.keys(WEATHER_CONDITIONS) as WeatherCondition[];
  liveBusy = signal(false);
  ngOnInit() {
    this.draft = structuredClone(this.settings);
  }
  ngAfterViewInit() {
    this.dialog.nativeElement.showModal();
  }
  close() {
    this.dialog.nativeElement.close();
  }
  defaults() {
    this.draft = defaultDemoSettings();
    this.error.set('');
  }
  save() {
    try {
      this.saved.emit(normalizeDemoSettings(this.draft));
      this.error.set('');
    } catch (e) {
      this.error.set(String(e));
    }
  }
  sendNotification(id: number) {
    try {
      this.notification.emit({ settings: normalizeDemoSettings(this.draft), id });
      this.error.set('');
    } catch (e) {
      this.error.set(String(e));
    }
  }
  /**
   * Replaces the sample forecast with the real one for these coordinates. The
   * reading is written into the draft rather than sent straight to the watch,
   * so what the user sees is what is saved, and a failure leaves the previous
   * sample values alone instead of half-applying.
   */
  async useLive() {
    this.liveBusy.set(true);
    try {
      const forecast = await fetchForecast({
        latitude: this.draft.latitude,
        longitude: this.draft.longitude,
        units: this.draft.weather.units,
      });
      this.draft.weather = {
        ...this.draft.weather,
        enabled: true,
        locationName:
          this.draft.weather.locationName.trim() ||
          coordinateName(this.draft.latitude, this.draft.longitude),
        phrase: forecast.shortPhrase,
        condition: forecast.condition,
        temperature: forecast.currentTemperature,
        todayHigh: forecast.todayHigh,
        todayLow: forecast.todayLow,
        tomorrowCondition: forecast.tomorrowCondition,
        tomorrowHigh: forecast.tomorrowHigh,
        tomorrowLow: forecast.tomorrowLow,
      };
      this.error.set('');
      this.save();
    } catch (e) {
      // Reported, never replaced with a forecast we made up.
      this.error.set(`Live weather unavailable: ${(e as Error).message}`);
    } finally {
      this.liveBusy.set(false);
    }
  }
  addNotification() {
    const id = Array.from({ length: 8 }, (_, i) => i).find(
      (i) => !this.draft.notifications.some((n) => n.id === i),
    );
    if (id !== undefined)
      this.draft.notifications.push({
        id,
        enabled: true,
        title: 'Demo message',
        body: 'A sample notification.',
      });
  }
  addEvent() {
    const id = Array.from({ length: 8 }, (_, i) => i).find(
      (i) => !this.draft.calendar.some((n) => n.id === i),
    );
    if (id !== undefined)
      this.draft.calendar.push({
        id,
        enabled: true,
        title: 'Demo event',
        location: '',
        startMinutes: 60,
        duration: 30,
      });
  }
  removeNotification(id: number) {
    this.draft.notifications = this.draft.notifications.filter((n) => n.id !== id);
  }
  removeEvent(id: number) {
    this.draft.calendar = this.draft.calendar.filter((n) => n.id !== id);
  }
}
