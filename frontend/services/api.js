import { API_URL } from '../constants/config';

export const fetchPrediction = async (matchId) => {
  try {
    const response = await fetch(`${API_URL}/api/predict`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ matchId })
    });
    if (!response.ok) {
        throw new Error(`Backend error: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.warn('Backend prediction fetch failed:', error);
    return null;
  }
};

export const checkBackendHealth = async () => {
    try {
        // Assuming root or health endpoint exists, otherwise just try to connect
        const response = await fetch(`${API_URL}/`);
        return response.ok;
    } catch (e) {
        return false;
    }
};
