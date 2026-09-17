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
    <dialog
      #surface
      class="phone-surface"
      aria-label="App configuration"
      (cancel)="$event.preventDefault(); close(null)"
    >
      <div class="heading">
        <div>
          <span class="label">App configuration</span><strong>{{ request.title }}</strong>
        </div>
        <button #closeButton (click)="close(null)" aria-label="Close app settings">
          Back to watch
        </button>
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
    </dialog>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .phone-surface {
      position: static;
      width: 100%;
      max-width: none;
      max-height: none;
      margin: 0;
      padding: 0;
      border: 0;
      color: var(--text);
      background: transparent;
      overflow: visible;
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
      height: min(640px, 72dvh);
      border: 1px solid var(--line);
      border-radius: 12px;
      background: white;
    }
    p {
      font-size: 14px;
      line-height: 1.5;
    }
    small {
      display: block;
      margin-top: 10px;
      font-size: 14px;
    }
    a {
      color: inherit;
    }
    @media (max-width: 780px) {
      .phone-surface[open] {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100dvh;
        display: flex;
        flex-direction: column;
        padding: max(12px, env(safe-area-inset-top)) 16px max(12px, env(safe-area-inset-bottom));
        background: var(--panel);
        overflow: auto;
      }
      iframe {
        height: calc(100dvh - 142px);
        min-height: 260px;
        flex: 1;
        border-radius: 8px;
      }
      .heading {
        min-height: 48px;
        margin-bottom: 12px;
      }
      small {
        margin-block: 10px 0;
      }
    }
  `,
})
export class PhoneAppPanel implements OnInit, AfterViewInit, OnDestroy {
  @Input({ required: true }) request!: PhoneConfiguration;
  @Output() returned = new EventEmitter<PhoneConfigurationResult>();
  @ViewChild('frame') frame?: ElementRef<HTMLIFrameElement>;
  @ViewChild('closeButton') closeButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('surface') surface!: ElementRef<HTMLDialogElement>;
  private mobile = matchMedia('(max-width: 780px)');
  private present = () => {
    const dialog = this.surface.nativeElement;
    dialog.close();
    if (this.mobile.matches) dialog.showModal();
    else dialog.show();
  };
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
    this.present();
    this.mobile.addEventListener('change', this.present);
    this.closeButton?.nativeElement.focus({ preventScroll: true });
    if (!this.mobile.matches)
      this.host.nativeElement.scrollIntoView({ block: 'start', inline: 'nearest' });
  }
  ngOnDestroy() {
    this.finished = true;
    clearTimeout(this.timeout);
    removeEventListener('message', this.onMessage);
    this.mobile.removeEventListener('change', this.present);
    this.surface?.nativeElement.close();
    if (this.previousFocus instanceof HTMLElement && this.previousFocus.isConnected) {
      const previous = this.previousFocus;
      requestAnimationFrame(() => {
        if (previous.isConnected) previous.focus();
      });
    }
  }
}
