import {
  Component,
  EventEmitter,
  Input,
  Output,
  OnChanges,
  OnDestroy,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { storeAppId, storePage, type StoreApp, type StoreCategory } from './store-catalog.ts';
import type { FirmwareProfile } from './watch-profiles.ts';

@Component({
  selector: 'store-browser',
  imports: [FormsModule],
  template: `
    <section class="store-browser" aria-label="Pebble store">
      <div class="section-heading">
        <h3>Pebble store</h3>
        <button (click)="closed.emit()" aria-label="Close store">Close</button>
      </div>
      <form (ngSubmit)="openLink()" class="store-link">
        <label
          >Store link<input
            [(ngModel)]="link"
            name="storeLink"
            placeholder="https://apps.repebble.com/… or app ID"
            type="text"
        /></label>
        <button type="submit" [disabled]="!link.trim() || disabled">Open</button>
      </form>
      <div class="field-grid">
        <label
          >Type<select [(ngModel)]="category" (ngModelChange)="reload()">
            <option value="watchfaces">Watchfaces</option>
            <option value="watchapps-and-companions">Apps</option>
          </select></label
        >
        <label
          >Browse<select [(ngModel)]="collection" (ngModelChange)="reload()">
            <option value="most-loved">Most loved</option>
            <option value="all">Recently updated</option>
          </select></label
        >
        <label
          >Filter these results<input
            [(ngModel)]="filter"
            type="search"
            placeholder="Name or author"
        /></label>
      </div>
      <div class="store-results">
        @for (app of filtered(); track app.id) {
          <article class="store-result">
            @if (app.screenshot) {
              <img
                [src]="app.screenshot"
                alt=""
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
              />
            }
            <div>
              <strong>{{ app.title }}</strong
              ><span>{{ app.author }} · {{ app.version }}</span
              ><a [href]="app.listing" target="_blank" rel="noopener noreferrer">Store details ↗</a>
            </div>
            <button
              (click)="selected.emit(app.id)"
              [disabled]="disabled"
              [attr.aria-label]="'Try ' + app.title"
            >
              Try
            </button>
          </article>
        } @empty {
          @if (!busy()) {
            <p class="help">
              {{
                filter
                  ? 'No matches in these results. Load more or paste a store link.'
                  : 'No results available. Retry or paste a store link.'
              }}
            </p>
          }
        }
      </div>
      @if (notice()) {
        <p class="help" role="status">{{ notice() }}</p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
        <button (click)="load()">Retry</button>
      }
      @if (busy()) {
        <p role="status">Loading store…</p>
        <button (click)="cancel()">Cancel loading</button>
      } @else if (more()) {
        <button (click)="load()">Load more results</button>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .store-browser {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--line, #d7dcdf);
    }
    h3 {
      margin: 0;
    }
    .store-link {
      display: flex;
      gap: 0.6rem;
      align-items: end;
      margin: 0.8rem 0;
    }
    .store-link label {
      flex: 1;
      min-width: 0;
    }
    .store-results {
      max-height: 440px;
      overflow: auto;
      overscroll-behavior: contain;
      margin: 0.7rem 0;
    }
    .store-result {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 0.2rem;
      border-bottom: 1px solid var(--line, #d7dcdf);
    }
    .store-result img {
      width: 48px;
      height: 56px;
      object-fit: contain;
      flex: none;
    }
    .store-result div {
      flex: 1;
      min-width: 0;
    }
    .store-result strong,
    .store-result span {
      display: block;
      overflow-wrap: anywhere;
    }
    .store-result span,
    .store-result a {
      font-size: 0.78rem;
    }
    .store-result span {
      opacity: 0.7;
      margin: 0.15rem 0;
    }
    .store-result button {
      flex: none;
    }
  `,
})
export class StoreBrowser implements OnChanges, OnDestroy {
  @Input() profile: FirmwareProfile = 'qemu_emery';
  @Input() disabled = false;
  @Output() selected = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();
  apps = signal<StoreApp[]>([]);
  busy = signal(false);
  more = signal(true);
  error = signal('');
  notice = signal('');
  collection: 'all' | 'most-loved' = 'most-loved';
  category: StoreCategory = 'watchfaces';
  filter = '';
  link = '';
  private offset = 0;
  private controller?: AbortController;
  private loadedProfile?: FirmwareProfile;
  ngOnChanges() {
    if (this.profile !== this.loadedProfile) this.reload();
  }
  ngOnDestroy() {
    this.controller?.abort();
  }
  filtered() {
    const q = this.filter.toLocaleLowerCase().trim();
    return this.apps().filter((a) => `${a.title} ${a.author}`.toLocaleLowerCase().includes(q));
  }
  reload() {
    this.controller?.abort();
    this.busy.set(false);
    this.loadedProfile = this.profile;
    this.offset = 0;
    this.apps.set([]);
    this.more.set(true);
    void this.load();
  }
  cancel() {
    this.controller?.abort();
    this.controller = undefined;
    this.busy.set(false);
  }
  async load() {
    if (this.busy()) return;
    const controller = new AbortController();
    this.controller = controller;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const page = await storePage(
        this.profile,
        this.collection,
        this.offset,
        controller.signal,
        undefined,
        this.category,
      );
      if (controller !== this.controller) return;
      this.apps.update((apps) => [
        ...apps,
        ...page.apps.filter((a) => !apps.some((b) => a.id === b.id)),
      ]);
      this.offset += page.count;
      this.more.set(page.more && page.count > 0 && this.offset < 2000);
      this.notice.set(
        [
          page.cached ? 'Showing saved catalog results.' : '',
          page.unavailable ? `${page.unavailable} entries have unavailable package metadata.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (error) {
      if (!controller.signal.aborted) this.error.set(String((error as Error).message));
    } finally {
      if (controller === this.controller) this.busy.set(false);
    }
  }
  openLink() {
    try {
      this.selected.emit(storeAppId(this.link));
    } catch {
      this.error.set('Paste a Pebble store link or its 24-character app ID.');
    }
  }
}
