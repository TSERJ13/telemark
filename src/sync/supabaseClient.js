'use strict';

/**
 * Supabase (dancesport.ge) REST client.
 * Pulls directly from PostgREST. Read-only for entries; writes results back
 * to tournament_registrations.result_place.
 *
 * Config: { url, key, fetchImpl }
 *   url  = https://<project>.supabase.co
 *   key  = service_role key (server-side only; never ship to tablets)
 *   fetchImpl = optional, for tests (defaults to global fetch)
 */

function createSupabase({ url, key, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  if (!f) throw new Error('No fetch available');
  const base = (url || '').replace(/\/$/, '') + '/rest/v1';
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  async function select(table, query = '') {
    const q = query ? `?${query}` : '?select=*';
    const res = await f(`${base}/${table}${q}`, { headers });
    if (!res.ok) {
      throw new Error(`Supabase ${table} ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  return {
    // --- pull (dancesport.ge -> telemark) ---
    tournamentsList: () => select('tournaments', 'select=id,name,event_date&order=event_date.desc'),
    tournament: (id) => select('tournaments', `id=eq.${id}&select=*`),
    categories: (tid) =>
      select(
        'tournament_categories',
        `tournament_id=eq.${tid}&select=*&order=category_order.asc`
      ),
    judges: (tid) =>
      select('tournament_judges', `tournament_id=eq.${tid}&select=*`),
    registrations: (tid) =>
      select(
        'tournament_registrations',
        `tournament_id=eq.${tid}&select=*`
      ),
    athletes: (ids) =>
      ids.length
        ? select('athletes', `id=in.(${ids.join(',')})&select=*`)
        : Promise.resolve([]),
    studios: (ids) =>
      ids.length
        ? select('studios', `id=in.(${ids.join(',')})&select=*`)
        : Promise.resolve([]),

    // --- push (telemark -> dancesport.ge) ---
    async pushResult(registrationId, place) {
      const res = await f(
        `${base}/tournament_registrations?id=eq.${registrationId}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({
            result_place: place,
            is_paid: true,
            paid_at: new Date().toISOString(),
          }),
        }
      );
      if (!res.ok) {
        throw new Error(`pushResult ${res.status}: ${await res.text()}`);
      }
      return true;
    },
  };
}

module.exports = { createSupabase };
