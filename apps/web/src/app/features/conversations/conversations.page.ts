import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { ConversationSummary } from '@frontdesk/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/api/api-error';
import { ConversationsApi } from '../../core/api/conversations-api';
import { AuthService } from '../../core/auth/auth.service';
import { formatDateTime } from '../../core/format';
import { CHANNEL_LABELS, OUTCOME_LABELS } from '../../core/labels';

const PAGE_SIZE = 25;

/** Every conversation the AI receptionist had (calls and test chats), newest first, for review. */
@Component({
  selector: 'app-conversations-page',
  imports: [RouterLink],
  templateUrl: './conversations.page.html',
  styleUrl: './conversations.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationsPage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ConversationsApi);

  protected readonly channelLabels = CHANNEL_LABELS;
  protected readonly outcomeLabels = OUTCOME_LABELS;

  protected readonly items = signal<ConversationSummary[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly loadError = signal<string | null>(null);

  /** Bumped on every reload so a slow answer for a practice we have left is ignored. */
  private generation = 0;

  constructor() {
    toObservable(this.auth.practiceId)
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load());
  }

  protected when(iso: string): string {
    return formatDateTime(iso, this.auth.practice()?.timezone);
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    const generation = this.generation;
    try {
      const page = await firstValueFrom(this.api.list({ limit: PAGE_SIZE, cursor }));
      if (generation !== this.generation) return;
      this.items.update((list) => [...list, ...page.items.filter((item) => !list.some((seen) => seen.id === item.id))]);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      if (generation === this.generation) this.loadError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loadingMore.set(false);
    }
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.loadError.set(null);
    this.items.set([]);
    this.nextCursor.set(null);
    try {
      const page = await firstValueFrom(this.api.list({ limit: PAGE_SIZE }));
      if (generation !== this.generation) return;
      this.items.set(page.items);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      if (generation === this.generation) this.loadError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
