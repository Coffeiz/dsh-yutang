export async function requestAdminLogout(fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher('/admin/v1/logout', { method: 'POST', credentials: 'same-origin' });
  // A 401 means the session is already expired or revoked, so it is safe to
  // finish clearing the local UI. Service errors must keep the session view.
  if (!response.ok && response.status !== 401) throw new Error('Admin logout was not confirmed');
}
