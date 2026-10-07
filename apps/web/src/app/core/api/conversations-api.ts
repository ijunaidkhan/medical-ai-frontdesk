import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { ConversationDetail, ConversationPage } from '@frontdesk/shared';
import type { Observable } from 'rxjs';

/** Conversations with the AI receptionist, for review. Opening one is recorded in the activity log by the server. */
@Injectable({ providedIn: 'root' })
export class ConversationsApi {
  private readonly http = inject(HttpClient);

  list(options: { limit?: number; cursor?: string | null } = {}): Observable<ConversationPage> {
    let params = new HttpParams();
    if (options.limit !== undefined) params = params.set('limit', options.limit);
    if (options.cursor) params = params.set('cursor', options.cursor);
    return this.http.get<ConversationPage>('/api/conversations', { params });
  }

  get(conversationId: string): Observable<ConversationDetail> {
    return this.http.get<ConversationDetail>(`/api/conversations/${encodeURIComponent(conversationId)}`);
  }
}
