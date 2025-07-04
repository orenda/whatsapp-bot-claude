const request = require('supertest');
const app = require('../dashboard');

describe('API authentication', () => {
  test('GET /api/tasks without token returns 401', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.statusCode).toBe(401);
  });

  test('POST /api/chats/123/monitor without token returns 401', async () => {
    const res = await request(app)
      .post('/api/chats/123/monitor')
      .send({ monitored: true });
    expect(res.statusCode).toBe(401);
  });
});
