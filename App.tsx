import React, { useState, useEffect } from 'react';
import LoginScreen from './components/LoginScreen';
import MainScreen from './components/MainScreen';
import AdminMap from './components/AdminMap'; // Importa o novo componente de mapa
import { User } from './types';
import { apiCall } from './api';
import { auth } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(() => {
    const savedUser = localStorage.getItem('bike_app_user');
    if (savedUser) {
      try {
        return JSON.parse(savedUser);
      } catch (e) {
        console.error("Failed to parse saved user", e);
        return null;
      }
    }
    return null;
  });
  // Novo estado para controlar a visibilidade do mapa em tempo real
  const [isMapVisible, setIsMapVisible] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        setIsAuthReady(true);
        setAuthError(null);
      }
    });
    
    // Timeout para mostrar erro se demorar muito (aumentado para 25s para dar tempo aos retries)
    const timer = setTimeout(() => {
      if (!auth.currentUser) {
        setAuthError("A conexão com o servidor de autenticação está instável. Tentando reconectar automaticamente... Se o problema persistir, verifique se seu navegador não está bloqueando conexões com o Firebase (ex: AdBlock).");
      }
    }, 25000);

    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  const handleRetryAuth = () => {
    setAuthError(null);
    window.location.reload(); // Recarrega para tentar novamente do zero
  };

  useEffect(() => {
    if (user) {
      localStorage.setItem('bike_app_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('bike_app_user');
    }
  }, [user]);

  const handleLogin = (loggedInUser: User) => {
    if (loggedInUser && loggedInUser.name && loggedInUser.name.trim()) {
      const userWithCategory = {
        ...loggedInUser,
        category: (loggedInUser.category || 'MOTORISTA').trim().toUpperCase(),
      };
      setUser(userWithCategory);
    }
  };

  const handleLogout = () => {
    if (user) {
      const userNameToLogout = user.name;
      setUser(null);
      localStorage.removeItem('bike_app_user');
      setIsMapVisible(false); // Garante que o mapa seja fechado ao fazer logout
      
      apiCall({ action: 'logout', userName: userNameToLogout })
        .catch(err => {
          console.error("Falha ao atualizar o status de logout no servidor:", err);
        });
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans flex flex-col items-center justify-center p-4">
      {isMapVisible && user?.category.includes('ADM') ? (
        // Se o mapa deve ser visível e o usuário é ADM, renderiza o AdminMap em tela cheia
        <div className="w-full h-screen max-w-full">
          <AdminMap 
            adminName={user.name} 
            onLogout={handleLogout} 
            onClose={() => setIsMapVisible(false)} 
          />
        </div>
      ) : (
        // Caso contrário, mostra a tela de login ou a tela principal
        <div className="w-full max-w-md mx-auto">
          {!user ? (
            <LoginScreen onLogin={handleLogin} />
          ) : !isAuthReady ? (
            <div className="flex flex-col items-center justify-center p-8 bg-white rounded-2xl shadow-sm border border-gray-100">
              {authError ? (
                <>
                  <div className="w-12 h-12 bg-red-50 text-red-500 rounded-full flex items-center justify-center mb-4">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <p className="text-gray-700 font-medium text-center mb-4">{authError}</p>
                  <button 
                    onClick={handleRetryAuth}
                    className="px-6 py-2 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition-colors"
                  >
                    Tentar Novamente
                  </button>
                </>
              ) : (
                <>
                  <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                  <p className="text-gray-500 font-medium">Conectando ao Firebase...</p>
                </>
              )}
            </div>
          ) : (
            <MainScreen 
              driverName={user.name} 
              category={user.category} 
              plate={user.plate}
              kmInicial={user.kmInicial}
              onLogout={handleLogout}
              onUpdateUser={(updates) => setUser(prev => prev ? { ...prev, ...updates } : null)}
              // Passa a função para a MainScreen poder abrir o mapa
              onShowMap={() => setIsMapVisible(true)}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default App;
