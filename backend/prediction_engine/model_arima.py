import numpy as np
from statsmodels.tsa.arima.model import ARIMA
from sklearn.metrics import mean_absolute_error
from skopt import gp_minimize
from skopt.space import Integer
from skopt.utils import use_named_args

class ARIMAModel:
    def __init__(self):
        self.model = None
        self.best_params = (1, 1, 1)

    def tune(self, data):
        y = data['y'].values
        
        # Define search space for (p, d, q)
        space = [
            Integer(0, 5, name='p'),
            Integer(0, 2, name='d'),
            Integer(0, 5, name='q')
        ]

        @use_named_args(space)
        def objective(**params):
            try:
                p, d, q = params['p'], params['d'], params['q']
                # Simple walk-forward validation
                train_size = int(len(y) * 0.8)
                train, test = y[:train_size], y[train_size:]
                
                model = ARIMA(train, order=(p, d, q))
                model_fit = model.fit()
                forecast = model_fit.forecast(steps=len(test))
                return mean_absolute_error(test, forecast)
            except:
                return 1e6

        res = gp_minimize(objective, space, n_calls=20, random_state=42)
        self.best_params = tuple(res.x)
        
        # Fit final model
        self.model = ARIMA(y, order=self.best_params).fit()
        return self.best_params, res.fun

    def predict(self, features):
        if not self.model:
            return 0
        return self.model.forecast(steps=1)[0]
