import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  CreateKnowledgeRequest,
  KnowledgeSearchResult,
  KnowledgeSourceDetail,
  KnowledgeSourceSummary,
  UpdateKnowledgeRequest,
} from '@frontdesk/shared';
import type { Observable } from 'rxjs';

/** The AI receptionist's knowledge base for the signed-in practice. The practice is never sent: the server reads it from the session. */
@Injectable({ providedIn: 'root' })
export class KnowledgeApi {
  private readonly http = inject(HttpClient);

  list(): Observable<KnowledgeSourceSummary[]> {
    return this.http.get<KnowledgeSourceSummary[]>('/api/knowledge');
  }

  get(id: string): Observable<KnowledgeSourceDetail> {
    return this.http.get<KnowledgeSourceDetail>(`/api/knowledge/${encodeURIComponent(id)}`);
  }

  /** What the AI receptionist would find for this question: approved entries only. */
  search(question: string): Observable<KnowledgeSearchResult[]> {
    return this.http.get<KnowledgeSearchResult[]>('/api/knowledge/search', { params: new HttpParams().set('q', question) });
  }

  create(entry: CreateKnowledgeRequest): Observable<KnowledgeSourceDetail> {
    return this.http.post<KnowledgeSourceDetail>('/api/knowledge', entry);
  }

  update(id: string, changes: UpdateKnowledgeRequest): Observable<KnowledgeSourceDetail> {
    return this.http.patch<KnowledgeSourceDetail>(`/api/knowledge/${encodeURIComponent(id)}`, changes);
  }

  approve(id: string): Observable<KnowledgeSourceDetail> {
    return this.http.post<KnowledgeSourceDetail>(`/api/knowledge/${encodeURIComponent(id)}/approve`, {});
  }

  archive(id: string): Observable<KnowledgeSourceDetail> {
    return this.http.post<KnowledgeSourceDetail>(`/api/knowledge/${encodeURIComponent(id)}/archive`, {});
  }

  restore(id: string): Observable<KnowledgeSourceDetail> {
    return this.http.post<KnowledgeSourceDetail>(`/api/knowledge/${encodeURIComponent(id)}/restore`, {});
  }
}
