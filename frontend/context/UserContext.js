import React, { createContext, useState, useContext, useEffect } from 'react';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const UserContext = createContext();

export const UserProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);

  // Listen for auth state changes
  useEffect(() => {
    const unsubscribeAuth = auth().onAuthStateChanged(async (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        setBalance(0);
        setLoading(false);
      }
    });
    return unsubscribeAuth;
  }, []);

  // Listen for user document changes when user is logged in
  useEffect(() => {
    let unsubscribeFirestore;
    
    if (user) {
      setLoading(true);
      const userDocRef = firestore().collection('users').doc(user.uid);
      
      unsubscribeFirestore = userDocRef.onSnapshot(
        (doc) => {
          if (doc.exists) {
            const userData = doc.data();
            // Default to 0 if tokens field is missing
            setBalance(userData?.tokens || 0);
          } else {
            console.log('User document does not exist');
            setBalance(0);
          }
          setLoading(false);
        },
        (error) => {
          console.error('Error fetching user data:', error);
          setLoading(false);
        }
      );
    } else {
      setBalance(0);
      setLoading(false);
    }

    return () => {
      if (unsubscribeFirestore) {
        unsubscribeFirestore();
      }
    };
  }, [user]);

  const addBalance = async (amount) => {
    if (!user) return;
    try {
      await firestore().collection('users').doc(user.uid).update({
        tokens: firestore.FieldValue.increment(amount)
      });
      // State updates automatically via onSnapshot
    } catch (error) {
      console.error('Error adding tokens:', error);
      throw error;
    }
  };

  const subtractBalance = async (amount) => {
    if (!user) return false;
    
    try {
      // Use transaction to ensure atomic update and sufficient balance
      await firestore().runTransaction(async (transaction) => {
        const userRef = firestore().collection('users').doc(user.uid);
        const userDoc = await transaction.get(userRef);
        
        if (!userDoc.exists) {
          throw new Error('User document does not exist!');
        }
        
        const currentTokens = userDoc.data().tokens || 0;
        if (currentTokens < amount) {
          throw new Error('Insufficient tokens');
        }
        
        transaction.update(userRef, {
          tokens: currentTokens - amount
        });
      });
      return true;
    } catch (error) {
      console.error('Error subtracting tokens:', error);
      return false;
    }
  };

  const transferTokens = async (recipientEmail, amount) => {
    if (!user) throw new Error('You must be logged in to transfer tokens.');
    if (amount <= 0) throw new Error('Amount must be positive.');
    if (recipientEmail.toLowerCase() === user.email.toLowerCase()) {
        throw new Error('You cannot transfer tokens to yourself.');
    }

    try {
        // Correct approach for Firestore Transfer:
        // 1. Query for recipient UID based on email (outside transaction)
        const recipientSnapshot = await firestore()
            .collection('users')
            .where('email', '==', recipientEmail)
            .limit(1)
            .get();

        if (recipientSnapshot.empty) {
            throw new Error('Recipient not found.');
        }

        const recipientDoc = recipientSnapshot.docs[0];
        const recipientUid = recipientDoc.id;

        // 2. Run Transaction with both UIDs
        await firestore().runTransaction(async (transaction) => {
            const senderRef = firestore().collection('users').doc(user.uid);
            const recipientRef = firestore().collection('users').doc(recipientUid);

            const sDoc = await transaction.get(senderRef);
            const rDoc = await transaction.get(recipientRef);

            if (!sDoc.exists) throw new Error('Sender account error.');
            if (!rDoc.exists) throw new Error('Recipient account error.');

            const sBalance = sDoc.data().tokens || 0;
            const rBalance = rDoc.data().tokens || 0;
            
            // Check Daily Limit
            const today = new Date().toISOString().split('T')[0];
            const lastDate = sDoc.data().lastTransferDate || '';
            let dailyTotal = sDoc.data().dailyTransferTotal || 0;

            if (lastDate !== today) {
                dailyTotal = 0;
            }

            if (dailyTotal + amount > 30) {
                throw new Error(`Daily transfer limit exceeded. You can only send ${Math.max(0, 30 - dailyTotal)} more APT today.`);
            }

            if (sBalance < amount) {
                throw new Error('Insufficient balance.');
            }

            transaction.update(senderRef, { 
                tokens: sBalance - amount,
                lastTransferDate: today,
                dailyTransferTotal: dailyTotal + amount
            });
            transaction.update(recipientRef, { tokens: rBalance + amount });
        });

        return true;
    } catch (error) {
        console.error('Transfer error:', error);
        throw error;
    }
  };

  return (
    <UserContext.Provider value={{ user, balance, addBalance, subtractBalance, transferTokens, loading }}>
      {children}
    </UserContext.Provider>
  );
};

export const useUser = () => {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
};
