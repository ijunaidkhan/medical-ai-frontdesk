import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CONTENT_MAX_LENGTH,
  KNOWLEDGE_SEARCH_MAX_LENGTH,
  KNOWLEDGE_TITLE_MAX_LENGTH,
  type KnowledgeCategory,
  type KnowledgeSearchResult,
  type KnowledgeSourceDetail,
  type KnowledgeSourceSummary,
  type UpdateKnowledgeRequest,
} from '@frontdesk/shared';
import { firstValueFrom, type Observable } from 'rxjs';
import { errorMessage } from '../../core/api/api-error';
import { KnowledgeApi } from '../../core/api/knowledge-api';
import { AuthService } from '../../core/auth/auth.service';
import { formatDateTime } from '../../core/format';
import { KNOWLEDGE_CATEGORY_LABELS, KNOWLEDGE_STATUS_LABELS } from '../../core/labels';

interface Draft {
  title: string;
  category: KnowledgeCategory;
  content: string;
}

const EMPTY_DRAFT: Draft = { title: '', category: 'general', content: '' };

/**
 * The information the AI receptionist may use to answer callers. Staff write it;
 * only what a person has approved can ever be used, and changing approved
 * wording sends it back to draft.
 */
@Component({
  selector: 'app-knowledge-page',
  templateUrl: './knowledge.page.html',
  styleUrl: './knowledge.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KnowledgePage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(KnowledgeApi);

  protected readonly categories = KNOWLEDGE_CATEGORIES;
  protected readonly categoryLabels = KNOWLEDGE_CATEGORY_LABELS;
  protected readonly statusLabels = KNOWLEDGE_STATUS_LABELS;
  protected readonly formatDateTime = formatDateTime;
  protected readonly limits = { title: KNOWLEDGE_TITLE_MAX_LENGTH, content: KNOWLEDGE_CONTENT_MAX_LENGTH, search: KNOWLEDGE_SEARCH_MAX_LENGTH };

  protected readonly sources = signal<KnowledgeSourceSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly showArchived = signal(false);

  /** The entry being edited (null for a new one), and the wording in the boxes. null draft = no editor open. */
  protected readonly selected = signal<KnowledgeSourceDetail | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly opening = signal(false);
  protected readonly working = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  protected readonly query = signal('');
  protected readonly results = signal<KnowledgeSearchResult[] | null>(null);
  protected readonly searching = signal(false);
  protected readonly searchProblem = signal<string | null>(null);

  protected readonly canManage = computed(() => this.auth.can('knowledge:manage'));
  protected readonly visible = computed(() => this.sources().filter((source) => (source.status === 'archived') === this.showArchived()));
  protected readonly archivedCount = computed(() => this.sources().filter((source) => source.status === 'archived').length);

  protected readonly isNew = computed(() => this.draft() !== null && this.selected() === null);
  protected readonly readOnly = computed(() => !this.canManage() || this.selected()?.status === 'archived');
  protected readonly changes = computed<UpdateKnowledgeRequest>(() => {
    const draft = this.draft();
    const current = this.selected();
    if (!draft || !current) return {};
    const changes: UpdateKnowledgeRequest = {};
    if (draft.title.trim() !== current.title) changes.title = draft.title.trim();
    if (draft.category !== current.category) changes.category = draft.category;
    if (draft.content.trim() !== current.content) changes.content = draft.content.trim();
    return changes;
  });
  protected readonly dirty = computed(() => {
    const draft = this.draft();
    if (!draft) return false;
    return this.isNew() ? draft.title.trim() !== '' || draft.content.trim() !== '' : Object.keys(this.changes()).length > 0;
  });
  protected readonly canSave = computed(() => {
    const draft = this.draft();
    if (!draft || this.readOnly() || this.working() || !this.dirty()) return false;
    return draft.title.trim() !== '' && draft.content.trim() !== '';
  });
  /** Editing the words of an approved entry withdraws its approval. */
  protected readonly wordingChanged = computed(() => this.selected()?.status === 'approved' && ('title' in this.changes() || 'content' in this.changes()));

  /** Bumped on every reload so a slow answer for a practice we have left is ignored. */
  private generation = 0;

  constructor() {
    toObservable(this.auth.practiceId)
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load());
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  protected setField<K extends keyof Draft>(field: K, value: Draft[K]): void {
    this.draft.update((draft) => (draft ? { ...draft, [field]: value } : draft));
  }

  protected chooseCategory(event: Event): void {
    const chosen = KNOWLEDGE_CATEGORIES.find((category) => category === this.value(event));
    if (chosen) this.setField('category', chosen);
  }

  // ------------------------------------------------------------ opening

  protected newEntry(): void {
    if (this.guardUnsaved()) return;
    this.resetMessages();
    this.selected.set(null);
    this.draft.set({ ...EMPTY_DRAFT });
  }

  protected async open(id: string): Promise<void> {
    if (this.guardUnsaved() || this.selected()?.id === id) return;
    this.resetMessages();
    const generation = this.generation;
    this.opening.set(true);
    try {
      const detail = await firstValueFrom(this.api.get(id));
      if (generation === this.generation) this.show(detail);
    } catch (error) {
      if (generation === this.generation) this.problem.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.opening.set(false);
    }
  }

  protected close(): void {
    this.resetMessages();
    this.selected.set(null);
    this.draft.set(null);
  }

  protected discard(): void {
    const current = this.selected();
    this.notice.set(null);
    this.problem.set(null);
    this.draft.set(current ? { title: current.title, category: current.category, content: current.content } : { ...EMPTY_DRAFT });
  }

  // ------------------------------------------------------------- saving

  protected async save(): Promise<void> {
    const draft = this.draft();
    if (!draft || !this.canSave()) return;
    const current = this.selected();
    const withdrawn = this.wordingChanged();
    await this.run(
      () => (current ? this.api.update(current.id, this.changes()) : this.api.create({ title: draft.title.trim(), category: draft.category, content: draft.content.trim() })),
      withdrawn ? 'Saved. Because the wording changed, this entry is a draft again and must be approved before the AI can use it.' : 'Saved.',
    );
  }

  protected approve(): Promise<void> {
    const current = this.selected();
    return current && !this.dirty() ? this.run(() => this.api.approve(current.id), 'Approved. The AI receptionist can now use this.') : Promise.resolve();
  }

  protected archive(): Promise<void> {
    const current = this.selected();
    return current && !this.dirty() ? this.run(() => this.api.archive(current.id), 'Archived. The AI receptionist no longer uses this.') : Promise.resolve();
  }

  protected restore(): Promise<void> {
    const current = this.selected();
    return current ? this.run(() => this.api.restore(current.id), 'Restored as a draft. Approve it to let the AI use it again.') : Promise.resolve();
  }

  // ------------------------------------------------------------- search

  protected async search(): Promise<void> {
    const question = this.query().trim();
    if (question === '' || this.searching()) return;
    this.searching.set(true);
    this.searchProblem.set(null);
    const generation = this.generation;
    try {
      const found = await firstValueFrom(this.api.search(question));
      if (generation === this.generation) this.results.set(found);
    } catch (error) {
      if (generation === this.generation) this.searchProblem.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.searching.set(false);
    }
  }

  // ------------------------------------------------------------ helpers

  /** Runs a change, shows the entry as the server now has it, and refreshes the list. */
  private async run(call: () => Observable<KnowledgeSourceDetail>, done: string): Promise<void> {
    this.working.set(true);
    this.problem.set(null);
    this.notice.set(null);
    const generation = this.generation;
    try {
      const detail = await firstValueFrom(call());
      if (generation !== this.generation) return;
      this.show(detail);
      this.notice.set(done);
      await this.refreshList(generation);
    } catch (error) {
      if (generation === this.generation) this.problem.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.working.set(false);
    }
  }

  private show(detail: KnowledgeSourceDetail): void {
    this.selected.set(detail);
    this.draft.set({ title: detail.title, category: detail.category, content: detail.content });
  }

  private resetMessages(): void {
    this.problem.set(null);
    this.notice.set(null);
  }

  /** Unsaved wording is never thrown away silently. */
  private guardUnsaved(): boolean {
    if (!this.dirty()) return false;
    this.notice.set(null);
    this.problem.set('You have unsaved changes. Save them, or choose “Discard changes”, first.');
    return true;
  }

  private async refreshList(generation: number): Promise<void> {
    try {
      const list = await firstValueFrom(this.api.list());
      if (generation === this.generation) this.sources.set(list);
    } catch {
      // The change itself succeeded; the list refreshes on the next visit.
    }
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.loadError.set(null);
    this.sources.set([]);
    this.selected.set(null);
    this.draft.set(null);
    this.results.set(null);
    this.query.set('');
    this.resetMessages();
    try {
      const list = await firstValueFrom(this.api.list());
      if (generation === this.generation) this.sources.set(list);
    } catch (error) {
      if (generation === this.generation) this.loadError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
