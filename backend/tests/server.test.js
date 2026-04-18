const request = require('supertest');
const io = require('socket.io-client');
const http = require('http');
// We'll need to export the app/server from server.js to test it properly
// For this demo, we'll assume the server is running on localhost:3000
const BASE_URL = 'http://localhost:3000';

describe('Apex Backend Integration Tests', () => {
  let socket;

  beforeAll((done) => {
    socket = io(BASE_URL);
    socket.on('connect', done);
  });

  afterAll(() => {
    socket.close();
  });

  test('GET /health should return 200 and traceId', async () => {
    const res = await request(BASE_URL).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('traceId');
    expect(res.body.status).toBe('ok');
  });

  test('GET /api/proxy should return data and traceId', async () => {
    const res = await request(BASE_URL)
      .get('/api/proxy')
      .query({ target: 'soccer/eng.1/scoreboard' });
    
    expect(res.statusCode).toBe(200);
    expect(res.header).toHaveProperty('x-trace-id');
  });

  test('POST /api/predict should trigger prediction engine', async () => {
    const res = await request(BASE_URL)
      .post('/api/predict')
      .send({ teamId: '382', sport: 'soccer', league: 'eng.1' });
    
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('prediction');
    expect(res.body).toHaveProperty('traceId');
  });

  test('Real-time update via WebSocket', (done) => {
    socket.on('data_updated', (data) => {
      expect(data).toHaveProperty('url');
      expect(data).toHaveProperty('traceId');
      done();
    });

    // Trigger an update that should emit a socket event
    request(BASE_URL)
      .get('/api/proxy')
      .query({ target: 'soccer/eng.1/scoreboard', force: true })
      .end();
  });
});
