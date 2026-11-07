import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

// One live feed: chat, proposals, reminders, payments.
// Secured through POST /api/agent-feed with owner authorization.
export function useAgentFeed(splitId, ownerKey) {
  const [entries, setEntries] = useState([]);
  const activeRef = useRef(true);

  const refetch = useCallback(async () => {
    if (!splitId || !ownerKey) {
      setEntries([]);
      return;
    }
    try {
      const data = await api('agent-feed', { method: 'POST', body: { splitId, ownerKey } });
      if (activeRef.current) {
        setEntries(data.entries || data || []);
      }
    } catch (err) {
      console.warn('Agent feed fetch error:', err.message);
    }
  }, [splitId, ownerKey]);

  useEffect(() => {
    activeRef.current = true;
    if (!splitId || !ownerKey) {
      setEntries([]);
      return () => {
        activeRef.current = false;
      };
    }
    refetch();
    const poll = setInterval(refetch, 5000);
    return () => {
      activeRef.current = false;
      clearInterval(poll);
    };
  }, [splitId, ownerKey, refetch]);

  return { entries, refetch };
}
