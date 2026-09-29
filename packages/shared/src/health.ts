export interface LivenessResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ok' | 'unavailable';
  checks: {
    database: 'up' | 'down';
  };
}
