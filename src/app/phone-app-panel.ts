// SPDX-License-Identifier: Apache-2.0
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

export interface PhoneConfiguration {
  url: string;
  requestId: number;
  generation: number;
  appId: string;
  title: string;
}
export interface PhoneConfigurationResult {
  request: PhoneConfiguration;
  response: string | null;
}

@Component({
  selector: 'phone-app-panel',
  template: `
    <div class="heading">
      <div>
        <span class="label">Pebble app</span><strong>{{ request.title }}</strong>
      </div>
      <button #closeButton (click)="close(null)" aria-label="Close app settings">Close</button>
    </div>
    @if (notice()) {
      <p role="status">{{ notice() }}</p>
    }
    <iframe #frame [src]="src" title="Pebble app settings" referrerpolicy="no-referrer"></iframe>
    <small
      ><a href="phone-app/README.md" target="_blank" rel="noopener"
        >Compatibility and source</a
      ></small
    >
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 12px;
    }
    .heading > div {
      display: grid;
      gap: 3px;
    }
    iframe {
      display: block;
      width: 100%;
      height: 580px;
      max-height: 78dvh;
      border: 1px solid var(--border, #ddd);
      border-radius: 10px;
      background: white;
    }
    p {
      font-size: 14px;
      line-height: 1.5;
    }
    small {
      display: block;
      margin-top: 10px;
      font-size: 12px;
    }
    a {
      color: inherit;
    }
  `,
})
export class PhoneAppPanel implements OnInit, AfterViewInit, OnDestroy {
  @Input({ required: true }) request!: PhoneConfiguration;
  @Output() returned = new EventEmitter<PhoneConfigurationResult>();
  @ViewChild('frame') frame?: ElementRef<HTMLIFrameElement>;
  @ViewChild('closeButton') closeButton?: ElementRef<HTMLButtonElement>;
  private host = inject(ElementRef<HTMLElement>);
  private previousFocus = document.activeElement;
  private sanitizer = inject(DomSanitizer);
  private session = crypto.randomUUID();
  private finished = false;
  private timeout?: ReturnType<typeof setTimeout>;
  src!: SafeResourceUrl;
  notice = signal('Loading Pebble app…');
  private onMessage = (event: MessageEvent) => {
    if (
      event.origin !== location.origin ||
      event.source !== this.frame?.nativeElement.contentWindow
    )
      return;
    const data = event.data;
    if (!data || data.session !== this.session || this.finished) return;
    if (data.type === 'phone-app-ready') {
      clearTimeout(this.timeout);
      this.notice.set('');
      this.frame!.nativeElement.contentWindow!.postMessage(
        { type: 'configure', session: this.session, ...this.request },
        location.origin,
      );
    } else if (data.type === 'phone-app-error' && typeof data.message === 'string') {
      this.notice.set(data.message.slice(0, 300));
    } else if (data.type === 'configuration-result') {
      if (
        data.response !== null &&
        (typeof data.response !== 'string' ||
          new TextEncoder().encode(data.response).length > 512 * 1024)
      )
        return;
      this.close(data.response);
    }
  };
  ngOnInit() {
    const url = new URL('phone-app/index.html', document.baseURI);
    url.searchParams.set('session', this.session);
    // Only the locally built companion module is trusted. Its configuration page uses an opaque sandbox.
    this.src = this.sanitizer.bypassSecurityTrustResourceUrl(url.href);
    addEventListener('message', this.onMessage);
    this.timeout = setTimeout(
      () =>
        this.notice.set(
          'The Pebble app is taking longer to load. If it stays blank, close settings and try again in an up-to-date browser.',
        ),
      30000,
    );
  }
  close(response: string | null) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timeout);
    this.returned.emit({ request: this.request, response });
  }
  ngAfterViewInit() {
    this.closeButton?.nativeElement.focus({ preventScroll: true });
    this.host.nativeElement.scrollIntoView({ block: 'start', inline: 'nearest' });
  }
  ngOnDestroy() {
    this.finished = true;
    clearTimeout(this.timeout);
    removeEventListener('message', this.onMessage);
    if (this.previousFocus instanceof HTMLElement && this.previousFocus.isConnected) {
      const previous = this.previousFocus;
      requestAnimationFrame(() => {
        if (previous.isConnected) previous.focus();
      });
    }
  }
}
