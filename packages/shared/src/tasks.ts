/**
 * Staff tasks: requests that need a person, such as a caller asking to be
 * phoned back or leaving a message. Created by staff, or by the AI receptionist
 * when it cannot help or the caller asks for a human.
 */
export const TASK_TYPES = ['callback', 'message', 'question', 'other'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['normal', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_DETAILS_MAX_LENGTH = 4_000;
export const TASK_CONTACT_NAME_MAX_LENGTH = 120;
export const TASK_PAGE_DEFAULT = 50;
export const TASK_PAGE_MAX = 200;

/** "active" means open or in progress: the work queue. */
export type TaskStatusFilter = TaskStatus | 'active' | 'all';

/**
 * Which moves between statuses are allowed. A finished task (done or
 * cancelled) can only be reopened, and must be reopened before it is edited.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['open', 'done', 'cancelled'],
  done: ['open'],
  cancelled: ['open'],
};

export interface TaskPerson {
  userId: string;
  name: string;
}

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  title: string;
  details: string | null;
  contactName: string | null;
  /** International format, e.g. +14155550123. */
  contactPhone: string | null;
  /** Who made it: a staff member, or the AI receptionist. */
  createdBy: { kind: 'user'; person: TaskPerson | null } | { kind: 'ai' };
  assignedTo: TaskPerson | null;
  /** The conversation it came from, when the AI receptionist created it. */
  conversationId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskRequest {
  type: TaskType;
  title: string;
  details?: string;
  contactName?: string;
  contactPhone?: string;
  priority?: TaskPriority;
  dueAt?: string;
  /** An active member of the practice. */
  assignedTo?: string;
}

/** Only the fields present are changed; `null` clears an optional field. */
export interface UpdateTaskRequest {
  title?: string;
  details?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  priority?: TaskPriority;
  dueAt?: string | null;
  assignedTo?: string | null;
  status?: TaskStatus;
}

/** Urgent tasks first, then newest first. Pass `nextCursor` back as `cursor` for the following page. */
export interface TaskPage {
  items: Task[];
  nextCursor: string | null;
}
