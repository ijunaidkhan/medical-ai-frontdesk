import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { ConversationDetail, ConversationToolCall, ConversationTurn } from '@frontdesk/shared';
import { combineLatest, firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/api/api-error';
import { ConversationsApi } from '../../core/api/conversations-api';
import { AuthService } from '../../core/auth/auth.service';
import { formatDateTime } from '../../core/format';
import { CHANNEL_LABELS, guardReasonLabel, OUTCOME_LABELS, toolLabel, turnSourceNote } from '../../core/labels';

const STATUS_LABELS = { ok: 'done', rejected: 'refused by the system', error: 'failed' } as const;

/** One line of the transcript, with the tools the AI used before answering it. */
interface Line {
  turn: ConversationTurn;
  note: string | null;
  tools: ConversationToolCall[];
}

/**
 * One conversation, as a reviewer needs it: every line, whether it was the AI's own words or a fixed or
 * system-written message, why a reply was replaced (and what the AI had tried to say), and every tool the
 * AI used. Opening it is recorded in the activity log by the server.
 */
@Component({
  selector: 'app-conversation-page',
  imports: [RouterLink],
  templateUrl: './conversation.page.html',
  styleUrl: './conversation.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationPage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ConversationsApi);
  private readonly route = inject(ActivatedRoute);

  protected readonly channelLabels = CHANNEL_LABELS;
  protected readonly outcomeLabels = OUTCOME_LABELS;
  protected readonly toolLabel = toolLabel;
  protected readonly guardReasonLabel = guardReasonLabel;

  protected readonly conversation = signal<ConversationDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);

  /** The transcript in order. Tools appear under the AI line that answered the caller line which led to them. */
  protected readonly lines = computed<Line[]>(() => {
    const conversation = this.conversation();
    if (!conversation) return [];
    const turns = [...conversation.turns].sort((a, b) => a.seq - b.seq);
    return turns.map((turn, index) => {
      const previous = turns[index - 1];
      const tools = turn.speaker === 'ai' && previous?.speaker === 'caller' ? conversation.toolCalls.filter((call) => call.turnSeq === previous.seq) : [];
      return { turn, note: turn.speaker === 'ai' ? turnSourceNote(turn.source) : null, tools };
    });
  });

  /** Bumped on every reload so a slow answer for something we have left is ignored. */
  private generation = 0;

  constructor() {
    combineLatest([this.route.paramMap, toObservable(this.auth.practiceId)])
      .pipe(takeUntilDestroyed())
      .subscribe(([params]) => void this.load(params.get('id') ?? ''));
  }

  protected when(iso: string): string {
    return formatDateTime(iso, this.auth.practice()?.timezone);
  }

  protected toolStatus(call: ConversationToolCall): string {
    return STATUS_LABELS[call.status];
  }

  protected json(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  private async load(id: string): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.loadError.set(null);
    this.conversation.set(null);
    try {
      const conversation = await firstValueFrom(this.api.get(id));
      if (generation === this.generation) this.conversation.set(conversation);
    } catch (error) {
      if (generation === this.generation) this.loadError.set(errorMessage(error, 'This conversation could not be opened.'));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
