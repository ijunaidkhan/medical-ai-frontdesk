import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type { AuditLogEntry } from '@frontdesk/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/api/api-error';
import { PracticeApi } from '../../core/api/practice-api';
import { AuthService } from '../../core/auth/auth.service';
import { formatDateTime } from '../../core/format';
import { auditLabel } from '../../core/labels';

const PAGE_SIZE = 25;

/** The practice's audit trail, newest first, loaded a page at a time. */
@Component({
  selector: 'app-activity-page',
  templateUrl: './activity.page.html',
  styleUrl: './activity.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivityPage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(PracticeApi);

  protected readonly auditLabel = auditLabel;
  protected readonly formatDateTime = formatDateTime;

  protected readonly entries = signal<AuditLogEntry[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** Bumped on every restart so a slow answer for a practice we have left is ignored. */
  private generation = 0;

  constructor() {
    toObservable(this.auth.practiceId)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.generation++;
        this.entries.set([]);
        this.nextCursor.set(null);
        void this.loadMore();
      });
  }

  protected async loadMore(): Promise<void> {
    const generation = this.generation;
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await firstValueFrom(this.api.auditLogs({ limit: PAGE_SIZE, cursor: this.nextCursor() }));
      if (generation !== this.generation) return;
      this.entries.update((existing) => [...existing, ...page.items]);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  protected describe(entry: AuditLogEntry): string {
    const reason = entry.metadata['reason'];
    return typeof reason === 'string' ? reason.replaceAll('_', ' ') : '';
  }
}
