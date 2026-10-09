# Apex Sports Prediction Platform

Apex is a multi-sport prediction and analytics application covering football, basketball, and tennis.

## Architecture & Data Providers

Apex employs a tiered data provider architecture designed for high availability and zero operating costs:

1. **ESPN (Primary Provider)**:
   - Primary data provider for all sports: football (top tiers), basketball (NBA, WNBA), and tennis (ATP, WTA).
2. **PitchAPI (Secondary Provider — Football)**:
   - Secondary provider filling missing lower divisions, regional tiers, and cup competitions across 77 football leagues.
   - 100% free with fair-use burst protection.

For full details on PitchAPI configuration, endpoints, rate limiting, and normalizers, see [backend/PITCHAPI_INTEGRATION.md](file:///c:/Users/prosp/Desktop/Apex/backend/PITCHAPI_INTEGRATION.md).

## Running the Application

### Backend
```bash
cd backend
npm install
npm test
npm start
```

### Frontend
```bash
cd frontend
npm install
npx expo start
```
