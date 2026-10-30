// Browser requests go only to the same-origin server proxy. The backend URL stays server-side.
(() => {
  const API_PREFIX = '/api/jobsai';

  async function request(path, { token, method = 'GET', body, contentType } = {}) {
    let response;
    const rawBody = body instanceof ArrayBuffer || ArrayBuffer.isView(body) || (typeof Blob !== 'undefined' && body instanceof Blob);
    try {
      response = await fetch(`${API_PREFIX}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': contentType || (rawBody ? 'application/octet-stream' : 'application/json') }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : rawBody ? body : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new Error('JobsAI could not reach its API. Please try again.');
    }

    if (response.status === 204) return null;
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error('JobsAI returned an unreadable response.'); }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'The request could not be completed.');
      error.code = payload?.error?.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  window.JobsAIAPI = Object.freeze({
    readyJobs: () => request('/v1/jobs/ready'),
    myJobs: token => request('/v1/jobs/mine', { token }),
    myAgents: token => request('/v1/agents', { token }),
    createAgent: (input, token) => request('/v1/agents', { method: 'POST', token, body: input }),
    rotateAgentToken: (agentId, expiresInDays, token) => request(`/v1/agents/${encodeURIComponent(agentId)}/runtime-token`, { method: 'POST', token, body: { expiresInDays } }),
    setAgentActive: (agentId, active, token) => request(`/v1/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', token, body: { active } }),
    jobTemplates: () => request('/v1/jobs/templates'),
    scoreJobBrief: (input, token) => request('/v1/jobs/quality', { method: 'POST', token, body: input }),
    draftJob: (prompt, token) => request('/v1/jobs/draft', { method: 'POST', token, body: { prompt } }),
    createJob: (input, token) => request('/v1/jobs', { method: 'POST', token, body: input }),
    fundJob: (jobId, transactionHash, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/fund`, { method: 'POST', token, body: { transactionHash } }),
    cancelJob: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', token, body: {} }),
    updatePayoutRecipient: (jobId, address, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/payout-recipient`, { method: 'POST', token, body: { address } }),
    issueNonce: address => request('/v1/auth/nonce', { method: 'POST', body: { address } }),
    verifyWallet: credentials => request('/v1/auth/verify', { method: 'POST', body: credentials }),
    logout: token => request('/v1/auth/logout', { method: 'POST', token }),
    claim: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/claim`, { method: 'POST', token, body: {} }),
    unclaim: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/unclaim`, { method: 'POST', token, body: {} }),
    takeOverAgentJob: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/take-over-agent`, { method: 'POST', token, body: {} }),
    releaseWorker: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/release-worker`, { method: 'POST', token, body: {} }),
    submissions: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/submissions`, { token }),
    revisions: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/revisions`, { token }),
    submitWork: (jobId, input, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/submissions`, { method: 'POST', token, body: input }),
    requestRevision: (jobId, feedback, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/revisions`, { method: 'POST', token, body: { feedback } }),
    acceptWork: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/accept`, { method: 'POST', token, body: {} }),
    openDispute: (jobId, reason, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/disputes`, { method: 'POST', token, body: { reason } }),
    teamLogin: (password, token) => request('/v1/team/auth/login', { method: 'POST', token, body: { password } }),
    teamStatus: token => request('/v1/team/auth/status', { token }),
    teamLogout: token => request('/v1/team/auth/logout', { method: 'POST', token, body: {} }),
    teamDisputes: token => request('/v1/team/disputes', { token }),
    teamDispute: (jobId, token) => request(`/v1/team/disputes/${encodeURIComponent(jobId)}`, { token }),
    resolveTeamDispute: (jobId, outcome, note, token) => request(`/v1/team/disputes/${encodeURIComponent(jobId)}/resolve`, { method: 'POST', token, body: { outcome, note } }),
    uploadImage: async (file, jobId, token) => request(`/v1/media/images?jobId=${encodeURIComponent(jobId)}`, { method: 'POST', token, body: await file.arrayBuffer(), contentType: file.type }),
  });
})();
