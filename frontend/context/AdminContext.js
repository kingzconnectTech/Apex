import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import auth from '@react-native-firebase/auth';
import { isAdminUser } from '../services/adminPicks';

/**
 * Tracks whether the signed-in user is an administrator.
 *
 * This is a UI convenience ONLY. The single source of truth is the Firebase
 * Authentication custom claim `admin: true`, verified server-side by the
 * Firestore security rules. Even if this context were wrong, a non-admin's
 * writes would still be refused by Firestore.
 */
const AdminContext = createContext({
  isAdmin: false,
  checking: true,
  refreshAdmin: async () => false,
});

export const AdminProvider = ({ children }) => {
  const [user, setUser] = useState(auth().currentUser);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);

  // Follow the auth state so a sign-out immediately drops admin access.
  useEffect(() => {
    const unsubscribe = auth().onAuthStateChanged(nextUser => setUser(nextUser));
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setIsAdmin(false);
      setChecking(false);
      return () => { cancelled = true; };
    }
    setChecking(true);
    isAdminUser(user, false)
      .then(ok => { if (!cancelled) { setIsAdmin(ok); setChecking(false); } })
      .catch(() => { if (!cancelled) { setIsAdmin(false); setChecking(false); } });
    return () => { cancelled = true; };
  }, [user]);

  /** Re-check the claim, optionally forcing a token refresh. */
  const refreshAdmin = useCallback(async (force = false) => {
    const ok = await isAdminUser(auth().currentUser, force);
    setIsAdmin(ok);
    setChecking(false);
    return ok;
  }, []);

  return (
    <AdminContext.Provider value={{ isAdmin, checking, refreshAdmin, user }}>
      {children}
    </AdminContext.Provider>
  );
};

export const useAdmin = () => useContext(AdminContext);
