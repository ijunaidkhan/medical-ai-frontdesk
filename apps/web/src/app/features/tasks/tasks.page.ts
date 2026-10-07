import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  PHONE_PATTERN,
  TASK_CONTACT_NAME_MAX_LENGTH,
  TASK_DETAILS_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  TASK_TRANSITIONS,
  TASK_TYPES,
  type MemberSummary,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskStatusFilter,
  type TaskType,
  type UpdateTaskRequest,
} from '@frontdesk/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/api/api-error';
import { PracticeApi } from '../../core/api/practice-api';
import { TasksApi } from '../../core/api/tasks-api';
import { AuthService } from '../../core/auth/auth.service';
import { formatDateTime } from '../../core/format';
import { TASK_ACTION_LABELS, TASK_STATUS_LABELS, TASK_TYPE_LABELS } from '../../core/labels';

const PAGE_SIZE = 50;

interface TaskDraft {
  type: TaskType;
  title: string;
  details: string;
  contactName: string;
  contactPhone: string;
  priority: TaskPriority;
}

const emptyDraft = (): TaskDraft => ({ type: 'callback', title: '', details: '', contactName: '', contactPhone: '', priority: 'normal' });
const draftOf = (task: Task): TaskDraft => ({
  type: task.type,
  title: task.title,
  details: task.details ?? '',
  contactName: task.contactName ?? '',
  contactPhone: task.contactPhone ?? '',
  priority: task.priority,
});
const finished = (status: TaskStatus) => status === 'done' || status === 'cancelled';

/** Whether a task belongs in the list for a status filter (a task that no longer does leaves the list). */
function matches(task: Task, status: TaskStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'active') return task.status === 'open' || task.status === 'in_progress';
  return task.status === status;
}

/**
 * The practice's work queue: callbacks and messages, from staff and from the AI receptionist. Urgent tasks
 * come first (the server orders them). Staff can create, assign, edit and complete them.
 */
@Component({
  selector: 'app-tasks-page',
  imports: [RouterLink],
  templateUrl: './tasks.page.html',
  styleUrl: './tasks.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TasksPage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(TasksApi);
  private readonly practiceApi = inject(PracticeApi);

  protected readonly typeLabels = TASK_TYPE_LABELS;
  protected readonly statusLabels = TASK_STATUS_LABELS;
  protected readonly actionLabels = TASK_ACTION_LABELS;
  protected readonly types = TASK_TYPES;
  protected readonly limits = { title: TASK_TITLE_MAX_LENGTH, details: TASK_DETAILS_MAX_LENGTH, name: TASK_CONTACT_NAME_MAX_LENGTH };

  protected readonly canManage = computed(() => this.auth.can('tasks:manage'));
  protected readonly canSeeConversations = computed(() => this.auth.can('calls:read'));

  protected readonly status = signal<TaskStatusFilter>('active');
  protected readonly assignee = signal('');
  protected readonly tasks = signal<Task[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly members = signal<MemberSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly rowError = signal<{ taskId: string; message: string } | null>(null);
  protected readonly busy = signal<string | null>(null);

  /** The task being edited, or "new" for a new one. */
  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal<TaskDraft>(emptyDraft());
  protected readonly editError = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected readonly activeMembers = computed(() => this.members().filter((member) => member.status === 'active'));
  protected readonly draftProblem = computed(() => {
    const draft = this.draft();
    if (draft.title.trim() === '') return 'Write a short title.';
    if (draft.contactPhone.trim() !== '' && !PHONE_PATTERN.test(draft.contactPhone.trim())) return 'Write the phone number with the country code, for example +14155550123.';
    return null;
  });

  /** Bumped on every reload so a slow answer for a practice or filter we have left is ignored. */
  private generation = 0;

  constructor() {
    toObservable(this.auth.practiceId)
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load(true));
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  protected when(iso: string): string {
    return formatDateTime(iso, this.auth.practice()?.timezone);
  }

  /** The status moves this task allows, in the order shown. */
  protected moves(task: Task): TaskStatus[] {
    return TASK_TRANSITIONS[task.status].filter((status) => status !== 'open' || finished(task.status));
  }

  protected isFinished(task: Task): boolean {
    return finished(task.status);
  }

  protected setStatus(status: string): void {
    if (!['active', 'open', 'in_progress', 'done', 'cancelled', 'all'].includes(status)) return;
    this.status.set(status as TaskStatusFilter);
    void this.load(false);
  }

  protected setAssignee(assignee: string): void {
    this.assignee.set(assignee);
    void this.load(false);
  }

  // ------------------------------------------------------------ changes

  protected async move(task: Task, status: TaskStatus): Promise<void> {
    await this.change(task, { status }, `“${task.title}”: ${TASK_STATUS_LABELS[status].toLowerCase()}.`);
  }

  protected async assign(task: Task, userId: string): Promise<void> {
    await this.change(task, { assignedTo: userId === '' ? null : userId }, null);
  }

  protected async assignToMe(task: Task): Promise<void> {
    const me = this.auth.user()?.id;
    if (me) await this.assign(task, me);
  }

  private async change(task: Task, changes: UpdateTaskRequest, notice: string | null): Promise<void> {
    if (!this.canManage() || this.busy()) return;
    this.busy.set(task.id);
    this.rowError.set(null);
    this.notice.set(null);
    const generation = this.generation;
    try {
      const updated = await firstValueFrom(this.api.update(task.id, changes));
      if (generation !== this.generation) return;
      this.replace(updated);
      if (notice) this.notice.set(notice);
    } catch (error) {
      if (generation === this.generation) this.rowError.set({ taskId: task.id, message: errorMessage(error) });
    } finally {
      if (generation === this.generation) this.busy.set(null);
    }
  }

  /** Puts a changed task back in the list, or takes it out when it no longer fits the filter. */
  private replace(updated: Task): void {
    const assignee = this.assignee();
    const fitsAssignee = assignee === '' || (assignee === 'unassigned' ? updated.assignedTo === null : updated.assignedTo?.userId === (assignee === 'me' ? this.auth.user()?.id : assignee));
    this.tasks.update((list) =>
      matches(updated, this.status()) && fitsAssignee ? list.map((task) => (task.id === updated.id ? updated : task)) : list.filter((task) => task.id !== updated.id),
    );
  }

  // ------------------------------------------------------------ editing

  protected startNew(): void {
    this.editing.set('new');
    this.draft.set(emptyDraft());
    this.editError.set(null);
  }

  protected startEdit(task: Task): void {
    this.editing.set(task.id);
    this.draft.set(draftOf(task));
    this.editError.set(null);
  }

  protected closeEditor(): void {
    this.editing.set(null);
    this.editError.set(null);
  }

  protected set<K extends keyof TaskDraft>(field: K, value: TaskDraft[K]): void {
    this.draft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected chooseType(value: string): void {
    const type = TASK_TYPES.find((candidate) => candidate === value);
    if (type) this.set('type', type);
  }

  protected async save(): Promise<void> {
    const editing = this.editing();
    if (!editing || !this.canManage() || this.saving() || this.draftProblem()) return;
    const draft = this.draft();
    this.saving.set(true);
    this.editError.set(null);
    const generation = this.generation;
    try {
      if (editing === 'new') {
        const created = await firstValueFrom(
          this.api.create({
            type: draft.type,
            title: draft.title.trim(),
            priority: draft.priority,
            ...(draft.details.trim() ? { details: draft.details.trim() } : {}),
            ...(draft.contactName.trim() ? { contactName: draft.contactName.trim() } : {}),
            ...(draft.contactPhone.trim() ? { contactPhone: draft.contactPhone.trim() } : {}),
          }),
        );
        if (generation !== this.generation) return;
        if (matches(created, this.status())) this.tasks.update((list) => [created, ...list]);
        this.notice.set(`Task added: “${created.title}”.`);
      } else {
        const original = this.tasks().find((task) => task.id === editing);
        if (!original) return;
        const before = draftOf(original);
        // Only what changed is sent; an emptied optional field is cleared.
        const changes: UpdateTaskRequest = {};
        if (draft.title.trim() !== before.title) changes.title = draft.title.trim();
        if (draft.details.trim() !== before.details) changes.details = draft.details.trim() || null;
        if (draft.contactName.trim() !== before.contactName) changes.contactName = draft.contactName.trim() || null;
        if (draft.contactPhone.trim() !== before.contactPhone) changes.contactPhone = draft.contactPhone.trim() || null;
        if (draft.priority !== before.priority) changes.priority = draft.priority;
        if (Object.keys(changes).length > 0) {
          const updated = await firstValueFrom(this.api.update(editing, changes));
          if (generation !== this.generation) return;
          this.replace(updated);
        }
      }
      this.editing.set(null);
    } catch (error) {
      if (generation === this.generation) this.editError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.saving.set(false);
    }
  }

  // ---------------------------------------------------------------- load

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    const generation = this.generation;
    try {
      const page = await firstValueFrom(this.api.list({ status: this.status(), assignee: this.assignee() || undefined, limit: PAGE_SIZE, cursor }));
      if (generation !== this.generation) return;
      this.tasks.update((list) => [...list, ...page.items.filter((task) => !list.some((seen) => seen.id === task.id))]);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      if (generation === this.generation) this.loadError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loadingMore.set(false);
    }
  }

  /** Loads the first page; `everything` also reloads the team list and clears the filters (a practice switch). */
  private async load(everything: boolean): Promise<void> {
    const generation = ++this.generation;
    if (everything) {
      this.status.set('active');
      this.assignee.set('');
      this.members.set([]);
      this.editing.set(null);
    }
    this.loading.set(true);
    this.loadError.set(null);
    this.notice.set(null);
    this.rowError.set(null);
    this.busy.set(null);
    this.tasks.set([]);
    this.nextCursor.set(null);
    try {
      const [page, members] = await Promise.all([
        firstValueFrom(this.api.list({ status: this.status(), assignee: this.assignee() || undefined, limit: PAGE_SIZE })),
        everything && this.auth.can('members:read') ? firstValueFrom(this.practiceApi.members()) : Promise.resolve(null),
      ]);
      if (generation !== this.generation) return;
      this.tasks.set(page.items);
      this.nextCursor.set(page.nextCursor);
      if (members) this.members.set(members);
    } catch (error) {
      if (generation === this.generation) this.loadError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
