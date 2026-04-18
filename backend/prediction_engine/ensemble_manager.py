import os
import joblib
import numpy as np
import pandas as pd
from skopt import BayesSearchCV
from sklearn.metrics import mean_absolute_error
from model_arima import ARIMAModel
from model_prophet import ProphetModel
from model_lstm import LSTMModel

class EnsembleManager:
    def __init__(self, model_dir="models"):
        self.model_dir = model_dir
        self.models = {
            "arima": ARIMAModel(),
            "prophet": ProphetModel(),
            "lstm": LSTMModel()
        }
        self.winning_model_name = None
        self.winning_model = None

    def load_latest_winning_model(self):
        meta_path = os.path.join(self.model_dir, "winning_model.meta")
        if os.path.exists(meta_path):
            meta = joblib.load(meta_path)
            self.winning_model_name = meta['name']
            model_path = os.path.join(self.model_dir, f"model_{self.winning_model_name}.pkl")
            if os.path.exists(model_path):
                self.winning_model = joblib.load(model_path)
                return True
        return False

    def predict(self, team_id, sport, league):
        if not self.winning_model:
            # Fallback to simple average or a default model if no winner yet
            return {"prediction": 0, "confidence": 0, "model": "none"}
        
        # Prepare features (simplified for this task)
        features = self._prepare_features(team_id, sport, league)
        prediction = self.winning_model.predict(features)
        
        return {
            "prediction": float(prediction),
            "model": self.winning_model_name,
            "timestamp": pd.Timestamp.now().isoformat()
        }

    def retrain_all(self, data=None):
        """
        Retrain all models using Bayesian Optimization and pick the best one.
        """
        if data is None:
            data = self._fetch_training_data()

        results = {}
        for name, model in self.models.items():
            print(f"Training {name}...")
            # Use Bayesian optimization within each model's tune method
            best_params, mae = model.tune(data)
            results[name] = {"mae": mae, "params": best_params}
            
            # Save each trained model
            joblib.dump(model, os.path.join(self.model_dir, f"model_{name}.pkl"))

        # Select winner
        self.winning_model_name = min(results, key=lambda k: results[k]['mae'])
        self.winning_model = self.models[self.winning_model_name]
        
        # Save winner metadata
        joblib.dump({
            "name": self.winning_model_name,
            "mae": results[self.winning_model_name]['mae'],
            "updated_at": pd.Timestamp.now().isoformat()
        }, os.path.join(self.model_dir, "winning_model.meta"))
        
        return results

    def _prepare_features(self, team_id, sport, league):
        # Placeholder for real feature engineering
        return np.array([0] * 10)

    def _fetch_training_data(self):
        # Placeholder for real data fetching from EspnClient
        # Should return a DataFrame with 'ds' (datestamp) and 'y' (target)
        dates = pd.date_range(end=datetime.now(), periods=100)
        return pd.DataFrame({'ds': dates, 'y': np.random.randn(100).cumsum()})
