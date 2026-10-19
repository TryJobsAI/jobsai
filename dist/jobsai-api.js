// Browser requests go only to the same-origin server proxy. The backend URL stays server-side.
(() => {
  const API_PREFIX = '/api/jobsai';

  async function request(path, { token, method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(`${API_PREFIX}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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
    if (!response.ok) throw new Error(payload?.error?.message || 'The request could not be completed.');
    return payload;
  }

  window.JobsAIAPI = Object.freeze({
    readyJobs: () => request('/v1/jobs/ready'),
    myJobs: token => request('/v1/jobs/mine', { token }),
    createJob: (input, token) => request('/v1/jobs', { method: 'POST', token, body: input }),
    fundJob: (jobId, transactionHash, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/fund`, { method: 'POST', token, body: { transactionHash } }),
    issueNonce: address => request('/v1/auth/nonce', { method: 'POST', body: { address } }),
    verifyWallet: credentials => request('/v1/auth/verify', { method: 'POST', body: credentials }),
    logout: token => request('/v1/auth/logout', { method: 'POST', token }),
    claim: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/claim`, { method: 'POST', token, body: {} }),
  });
})();
