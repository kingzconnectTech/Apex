import React, { createContext, useState, useContext } from 'react';

const UserContext = createContext();

export const UserProvider = ({ children }) => {
  const [balance, setBalance] = useState(30); // Initial balance

  const addBalance = (amount) => {
    setBalance((prev) => prev + amount);
  };

  const subtractBalance = (amount) => {
    if (balance >= amount) {
      setBalance((prev) => prev - amount);
      return true;
    }
    return false;
  };

  return (
    <UserContext.Provider value={{ balance, addBalance, subtractBalance }}>
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
