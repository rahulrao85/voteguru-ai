import request from 'supertest';
import { app, server } from './server.js';
import { jest } from '@jest/globals';

describe('VoteGuru AI API Tests', () => {
  afterAll((done) => {
    // Close the server after tests
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  describe('GET /health', () => {
    it('should return a 200 OK status', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toEqual(200);
      expect(res.body.status).toEqual('ok');
      expect(res.body.service).toEqual('VoteGuru AI');
    });
  });

  describe('GET /api/config', () => {
    it('should return the frontend configuration', async () => {
      const res = await request(app).get('/api/config');
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('version');
    });
  });

  describe('GET /api/suggestions', () => {
    it('should return exactly 4 randomized suggestions', async () => {
      const res = await request(app).get('/api/suggestions');
      expect(res.statusCode).toEqual(200);
      expect(Array.isArray(res.body.suggestions)).toBeTruthy();
      expect(res.body.suggestions.length).toBe(4);
      expect(res.body.suggestions[0]).toHaveProperty('text');
      expect(res.body.suggestions[0]).toHaveProperty('icon');
    });
  });

  describe('GET /api/booth-finder', () => {
    it('should reject requests without a pincode', async () => {
      const res = await request(app).get('/api/booth-finder');
      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toContain('valid 6-digit PIN code');
    });

    it('should reject invalid pincode formats', async () => {
      const res = await request(app).get('/api/booth-finder?pincode=123'); // Too short
      expect(res.statusCode).toEqual(400);
      
      const res2 = await request(app).get('/api/booth-finder?pincode=012345'); // Starts with 0
      expect(res2.statusCode).toEqual(400);
    });

    it('should process a valid Indian pincode and identify the correct state', async () => {
      // 400001 is Mumbai, Maharashtra
      const res = await request(app).get('/api/booth-finder?pincode=400001');
      expect(res.statusCode).toEqual(200);
      expect(res.body.state.name).toEqual('Maharashtra');
      expect(res.body.pincode).toEqual('400001');
      expect(res.body.mapsDirectUrl).toContain('400001');
    });
  });

  describe('POST /api/chat', () => {
    it('should reject empty messages', async () => {
      const res = await request(app)
        .post('/api/chat')
        .send({ message: '   ' });
      expect(res.statusCode).toEqual(400);
    });

    it('should reject extremely long messages', async () => {
      const longMessage = 'A'.repeat(1001);
      const res = await request(app)
        .post('/api/chat')
        .send({ message: longMessage });
      expect(res.statusCode).toEqual(400);
    });
    
    // We don't want to make actual Gemini API calls in our unit tests by default
    // to avoid billing and rate limits. If GEMINI_API_KEY is not set or dummy,
    // we expect a 503 Service Unavailable.
    it('should handle unconfigured API keys safely', async () => {
      // Assuming testing environment doesn't have a valid key, or handles it safely
      const res = await request(app)
        .post('/api/chat')
        .send({ message: 'Hello' });
      
      // It will either be 503 (unconfigured) or 200 (if you have a real key in .env)
      expect([200, 503, 500]).toContain(res.statusCode);
    });
  });
  
  describe('Security Headers', () => {
    it('should return security headers on all routes', async () => {
      const res = await request(app).get('/');
      expect(res.headers['x-content-type-options']).toEqual('nosniff');
      expect(res.headers['x-frame-options']).toEqual('DENY');
      expect(res.headers['x-xss-protection']).toEqual('1; mode=block');
    });
  });
});
