import pandas as pd
from prophet import Prophet
from sklearn.metrics import mean_absolute_error
from skopt import gp_minimize
from skopt.space import Real, Categorical
from skopt.utils import use_named_args

class ProphetModel:
    def __init__(self):
        self.model = None
        self.best_params = {}

    def tune(self, data):
        # Prophet expects columns 'ds' and 'y'
        df = data[['ds', 'y']].copy()
        
        space = [
            Real(0.001, 0.5, name='changepoint_prior_scale'),
            Real(0.01, 10.0, name='seasonality_prior_scale'),
            Categorical(['additive', 'multiplicative'], name='seasonality_mode')
        ]

        @use_named_args(space)
        def objective(**params):
            try:
                train_size = int(len(df) * 0.8)
                train, test = df.iloc[:train_size], df.iloc[train_size:]
                
                m = Prophet(**params)
                m.fit(train)
                
                future = m.make_future_dataframe(periods=len(test))
                forecast = m.predict(future)
                y_pred = forecast.iloc[train_size:]['yhat'].values
                return mean_absolute_error(test['y'], y_pred)
            except:
                return 1e6

        res = gp_minimize(objective, space, n_calls=15, random_state=42)
        
        # Best params
        self.best_params = {
            'changepoint_prior_scale': res.x[0],
            'seasonality_prior_scale': res.x[1],
            'seasonality_mode': res.x[2]
        }
        
        # Fit final model
        self.model = Prophet(**self.best_params)
        self.model.fit(df)
        return self.best_params, res.fun

    def predict(self, features):
        if not self.model:
            return 0
        # For prediction, we need a future dataframe
        future = self.model.make_future_dataframe(periods=1)
        forecast = self.model.predict(future)
        return forecast.iloc[-1]['yhat']
