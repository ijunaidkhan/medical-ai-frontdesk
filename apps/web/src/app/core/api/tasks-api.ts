import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { CreateTaskRequest, Task, TaskPage, TaskStatusFilter, UpdateTaskRequest } from '@frontdesk/shared';
import type { Observable } from 'rxjs';

export interface TaskFilter {
  status?: TaskStatusFilter;
  /** "me", "unassigned", or a member's user id. */
  assignee?: string;
  limit?: number;
  cursor?: string | null;
}

/** The practice's task queue (callbacks and messages). The practice is never sent: the server reads it from the session. */
@Injectable({ providedIn: 'root' })
export class TasksApi {
  private readonly http = inject(HttpClient);

  list(filter: TaskFilter = {}): Observable<TaskPage> {
    let params = new HttpParams();
    if (filter.status) params = params.set('status', filter.status);
    if (filter.assignee) params = params.set('assignee', filter.assignee);
    if (filter.limit !== undefined) params = params.set('limit', filter.limit);
    if (filter.cursor) params = params.set('cursor', filter.cursor);
    return this.http.get<TaskPage>('/api/tasks', { params });
  }

  create(task: CreateTaskRequest): Observable<Task> {
    return this.http.post<Task>('/api/tasks', task);
  }

  update(taskId: string, changes: UpdateTaskRequest): Observable<Task> {
    return this.http.patch<Task>(`/api/tasks/${encodeURIComponent(taskId)}`, changes);
  }
}
