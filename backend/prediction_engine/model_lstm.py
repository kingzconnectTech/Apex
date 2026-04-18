import numpy as np
import pandas as pd
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense
from sklearn.preprocessing import MinMaxScaler
from sklearn.metrics import mean_absolute_error
from skopt import gp_minimize
from skopt.space import Integer, Real
from skopt.utils import use_named_args

class LSTMModel:
    def __init__(self):
        self.model = None
        self.scaler = MinMaxScaler()
        self.window_size = 10

    def _create_dataset(self, dataset):
        dataX, dataY = [], []
        for i in range(len(dataset) - self.window_size):
            a = dataset[i:(i + self.window_size), 0]
            dataX.append(a)
            dataY.append(dataset[i + self.window_size, 0])
        return np.array(dataX), np.array(dataY)

    def tune(self, data):
        y = data['y'].values.reshape(-1, 1)
        scaled_data = self.scaler.fit_transform(y)
        
        X, y_data = self._create_dataset(scaled_data)
        X = np.reshape(X, (X.shape[0], X.shape[1], 1))
        
        train_size = int(len(X) * 0.8)
        X_train, X_test = X[:train_size], X[train_size:]
        y_train, y_test = y_data[:train_size], y_data[train_size:]

        space = [
            Integer(10, 100, name='units'),
            Real(0.0001, 0.01, prior='log-uniform', name='lr'),
            Integer(10, 50, name='epochs')
        ]

        @use_named_args(space)
        def objective(**params):
            try:
                model = Sequential([
                    LSTM(params['units'], input_shape=(self.window_size, 1)),
                    Dense(1)
                ])
                model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate=params['lr']), loss='mae')
                model.fit(X_train, y_train, epochs=params['epochs'], batch_size=16, verbose=0)
                
                y_pred_scaled = model.predict(X_test)
                y_pred = self.scaler.inverse_transform(y_pred_scaled)
                y_true = self.scaler.inverse_transform(y_test.reshape(-1, 1))
                
                return mean_absolute_error(y_true, y_pred)
            except Exception as e:
                print(f"LSTM Tune Error: {e}")
                return 1e6

        res = gp_minimize(objective, space, n_calls=10, random_state=42)
        
        # Best params
        best_params = {
            'units': res.x[0],
            'lr': res.x[1],
            'epochs': res.x[2]
        }
        
        # Fit final model
        self.model = Sequential([
            LSTM(best_params['units'], input_shape=(self.window_size, 1)),
            Dense(1)
        ])
        self.model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate=best_params['lr']), loss='mae')
        self.model.fit(X, y_data, epochs=best_params['epochs'], batch_size=16, verbose=0)
        
        return best_params, res.fun

    def predict(self, features):
        if not self.model:
            return 0
        
        # features should be the last 'window_size' data points
        # For demo, we'll assume features is the correct shape
        # In real case, we'd fetch the last N points and scale them
        last_window = np.zeros((1, self.window_size, 1)) 
        prediction_scaled = self.model.predict(last_window)
        return self.scaler.inverse_transform(prediction_scaled)[0, 0]
