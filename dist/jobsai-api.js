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
    workerProfile: token => request('/v1/workers/me', { token }),
    submitWorkerProfile: (profile, token) => request('/v1/workers/me', { method: 'PUT', token, body: profile }),
    publicWorkerProfile: slug => request(`/v1/workers/${encodeURIComponent(slug)}`),
    userTag: token => request('/v1/user-tags/me', { token }),
    setUserTag: (userTag, token) => request('/v1/user-tags/me', { method: 'PUT', token, body: { userTag } }),
    publicUserTag: userTag => request(`/v1/user-tags/${encodeURIComponent(userTag)}`),
    adminStatus: token => request('/v1/admin/me', { token }),
    adminUsers: token => request('/v1/admin/users', { token }),
    addAdmin: (userTag, token) => request('/v1/admin/users', { method: 'POST', token, body: { userTag } }),
    removeAdmin: (userTag, token) => request(`/v1/admin/users/${encodeURIComponent(userTag)}`, { method: 'DELETE', token }),
    workerApplications: token => request('/v1/admin/worker-applications', { token }),
    reviewWorkerApplication: (id, decision, note, token) => request(`/v1/admin/worker-applications/${encodeURIComponent(id)}/review`, { method: 'POST', token, body: { decision, ...(note ? { note } : {}) } }),
    webhooks: token => request('/v1/webhooks', { token }),
    createWebhook: (input, token) => request('/v1/webhooks', { method: 'POST', token, body: input }),
    updateWebhook: (id, input, token) => request(`/v1/webhooks/${encodeURIComponent(id)}`, { method: 'PATCH', token, body: input }),
    deleteWebhook: (id, token) => request(`/v1/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE', token }),
    rotateWebhookSecret: (id, token) => request(`/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`, { method: 'POST', token, body: {} }),
    testWebhook: (id, token) => request(`/v1/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST', token, body: {} }),
    webhookDeliveries: (id, token) => request(`/v1/webhooks/${encodeURIComponent(id)}/deliveries`, { token }),
    buyerApiKeyInfo: token => request('/v1/buyer/keys', { token }),
    createBuyerApiKey: token => request('/v1/buyer/keys', { method: 'POST', token, body: {} }),
    revokeBuyerApiKey: token => request('/v1/buyer/keys/revoke', { method: 'POST', token, body: {} }),
    createAgent: (input, token) => request('/v1/agents', { method: 'POST', token, body: input }),
    rotateAgentToken: (agentId, expiresInDays, token) => request(`/v1/agents/${encodeURIComponent(agentId)}/runtime-token`, { method: 'POST', token, body: { expiresInDays } }),
    setAgentActive: (agentId, active, token) => request(`/v1/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', token, body: { active } }),
    jobTemplates: () => request('/v1/jobs/templates'),
    services: category => request(`/v1/services${category ? `?category=${encodeURIComponent(category)}` : ''}`),
    myServices: token => request('/v1/services/mine', { token }),
    createService: (input, token) => request('/v1/services', { method: 'POST', token, body: input }),
    setServiceActive: (serviceId, active, token) => request(`/v1/services/${encodeURIComponent(serviceId)}`, { method: 'PATCH', token, body: { active } }),
    orderService: (serviceId, details, token) => request(`/v1/services/${encodeURIComponent(serviceId)}/order`, { method: 'POST', token, body: { details } }),
    scoreJobBrief: (input, token) => request('/v1/jobs/quality', { method: 'POST', token, body: input }),
    draftJob: (prompt, token) => request('/v1/jobs/draft', { method: 'POST', token, body: { prompt } }),
    createJob: (input, token) => request('/v1/jobs', { method: 'POST', token, body: input }),
    myInvitations: token => request('/v1/jobs/invitations/mine', { token }),
    inviteWorker: (jobId, wallet, message, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/invitation`, { method: 'POST', token, body: { wallet, ...(message ? { message } : {}) } }),
    acceptInvitation: (jobId, agentId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/invitation/accept`, { method: 'POST', token, body: agentId ? { agentId } : {} }),
    declineInvitation: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/invitation/decline`, { method: 'POST', token, body: {} }),
    openJob: (jobId, selectionMode, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/open`, { method: 'POST', token, body: { selectionMode } }),
    proposals: (jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/proposals`, { token }),
    myProposals: token => request('/v1/jobs/proposals/mine', { token }),
    sendProposal: (jobId, input, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/proposals`, { method: 'POST', token, body: input }),
    withdrawProposal: (jobId, proposalId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/proposals/${encodeURIComponent(proposalId)}/withdraw`, { method: 'POST', token, body: {} }),
    acceptProposal: (jobId, proposalId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/proposals/${encodeURIComponent(proposalId)}/accept`, { method: 'POST', token, body: {} }),
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
    aiCheck: (jobId, submissionId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/ai-check${submissionId ? `?submissionId=${encodeURIComponent(submissionId)}` : ''}`, { token }),
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
    uploadJobSource: async (file, jobId, token) => request(`/v1/jobs/${encodeURIComponent(jobId)}/source-file`, { method: 'POST', token, body: await file.arrayBuffer(), contentType: file.type || ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain' }[file.name.split('.').pop()?.toLowerCase()] || 'application/octet-stream') }),
    transcribeAudio: (blob, token) => request('/v1/speech/transcribe', { method: 'POST', token, body: blob, contentType: blob.type }),
  });
})();
