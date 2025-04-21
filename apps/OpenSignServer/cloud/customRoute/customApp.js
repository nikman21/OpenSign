import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import uploadFile from './uploadFile.js';
import Parse from 'parse/node.js';

export const app = express();

// Initialize Parse for WebhookConfig operations
Parse.initialize(process.env.APP_ID, '', process.env.MASTER_KEY);
Parse.serverURL = process.env.SERVER_URL;

dotenv.config();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Save or update the URL where you want OpenSign to POST events
app.post('/app/webhook', async (req, res) => {
    if (req.headers['x-api-token'] !== process.env.MASTER_KEY) {
      return res.status(401).send('Unauthorized');
    }
    const { url } = req.body;
    if (!url) {
      return res.status(400).send('Missing url parameter');
    }
    // Upsert singleton WebhookConfig
    const WebhookConfig = Parse.Object.extend('WebhookConfig');
    const q = new Parse.Query(WebhookConfig);
    let cfg = await q.first({ useMasterKey: true });
    if (!cfg) cfg = new WebhookConfig();
    cfg.set('url', url);
    await cfg.save(null, { useMasterKey: true });
    return res.json({ url });
  });
  
  // Retrieve the currently saved webhook URL
  app.get('/app/webhook', async (req, res) => {
    if (req.headers['x-api-token'] !== process.env.MASTER_KEY) {
      return res.status(401).send('Unauthorized');
    }
    const WebhookConfig = Parse.Object.extend('WebhookConfig');
    const q = new Parse.Query(WebhookConfig);
    const cfg = await q.first({ useMasterKey: true });
    return res.json({ url: cfg ? cfg.get('url') : null });
});


app.post('/file_upload', uploadFile);

