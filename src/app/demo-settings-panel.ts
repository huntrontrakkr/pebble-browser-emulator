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
  @Input() theme = 'light';
  @Output() themeChanged = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<DemoSettings>();
  @Output() notification = new EventEmitter<{ settings: DemoSettings; id: number }>();
  @Output() signalSent = new EventEmitter<DeviceSignal>();
  @ViewChild('dialog') dialog!: ElementRef<HTMLDialogElement>;
  draft = defaultDemoSettings();
  error = signal('');
  metrics = HEALTH_METRICS;
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
