import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

// Participants for a split, retrieved via GET /api/split and kept fresh with periodic polling.
export function useParticipants(splitId) {
  const [rows, setRows] = useState([]);
  const activeRef = useRef(true);
  const reqIdRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!splitId) return;
    const reqId = ++reqIdRef.current;
    try {
      const data = await api('split', { query: { id: splitId } });
      if (activeRef.current && reqId === reqIdRef.current) {
        setRows(data.participants || []);
      }
    } catch (err) {
      console.warn('Failed to fetch participants:', err.message);
    }
  }, [splitId]);

  useEffect(() => {
    activeRef.current = true;
    if (!splitId) {
      setRows([]);
      return undefined;
    }
    refetch();
    const poll = setInterval(refetch, 5000);
    return () => {
      activeRef.current = false;
      clearInterval(poll);
    };
  }, [splitId, refetch]);

  return { rows, refetch };
}
