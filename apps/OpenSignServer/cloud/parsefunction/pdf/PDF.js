import fs from 'node:fs';
import axios from 'axios';
import { PDFDocument } from 'pdf-lib';
import {
  cloudServerUrl,
  replaceMailVaribles,
  saveFileUsage,
  getSecureUrl,
  appName,
} from '../../../Utils.js';
import GenerateCertificate from './GenerateCertificate.js';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { Placeholder } from './Placeholder.js';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';

const serverUrl = cloudServerUrl; // process.env.SERVER_URL;
const APPID = process.env.APP_ID;
const masterKEY = process.env.MASTER_KEY;
const eSignName = 'OpenSign';
const eSigncontact = 'hello@opensignlabs.com';

async function unlinkFile(path) {
  if (fs.existsSync(path)) {
    try {
      fs.unlinkSync(path);
    } catch (err) {
      console.log('Err in unlink file:', path, err);
    }
  }
}

// Upload PDF to Parse File storage
async function uploadFile(pdfName, filepath) {
  try {
    const filedata = fs.readFileSync(filepath);
    const file = new Parse.File(pdfName, [...filedata], 'application/pdf');
    await file.save(null, { useMasterKey: true });
    const fileRes = getSecureUrl(file.url());
    return { imageUrl: fileRes.url };
  } catch (err) {
    console.log('Err in uploadFile:', err);
    unlinkFile(filepath);
    throw err;
  }
}

// Update contracts_Document record after signing
async function updateDoc(docId, url, userId, ipAddress, data, className, sign) {
  try {
    const UserPtr = { __type: 'Pointer', className, objectId: userId };
    const obj = {
      UserPtr,
      SignedUrl: url,
      Activity: 'Signed',
      ipAddress,
      SignedOn: new Date(),
      Signature: sign,
    };
    let AuditTrail = Array.isArray(data.AuditTrail) ? [...data.AuditTrail] : [];
    const existingIndex = AuditTrail.findIndex(
      (entry) => entry.UserPtr.objectId === userId && entry.Activity !== 'Created'
    );
    if (existingIndex !== -1) {
      AuditTrail[existingIndex] = { ...AuditTrail[existingIndex], ...obj };
    } else {
      AuditTrail.push(obj);
    }
    const isCompleted = Array.isArray(data.Signers)
      ? AuditTrail.filter((x) => x.Activity === 'Signed').length === data.Placeholders.length
      : true;
    const body = { SignedUrl: url, AuditTrail, IsCompleted: isCompleted };
    await axios.put(
      `${serverUrl}/classes/contracts_Document/${docId}`,
      body,
      { headers: { 'Content-Type': 'application/json', 'X-Parse-Application-Id': APPID, 'X-Parse-Master-Key': masterKEY } }
    );
    return { isCompleted, message: 'success', AuditTrail };
  } catch (err) {
    console.log('Err in updateDoc:', err);
    throw err;
  }
}

// Notify document owner when a signer signs
async function sendNotifyMail(doc, signUser, mailProvider, publicUrl) {
  try {
    const TenantAppName = appName;
    const logo = "<img src='https://qikinnovation.ams3.digitaloceanspaces.com/logo.png' height='50' style='padding:20px'/>";
    const viewDocUrl = `${publicUrl}/recipientSignPdf/${doc.objectId}`;
    const subject = `Document "${doc.Name}" signed by ${signUser.Name}`;
    const body = `
      <html><body>
      <div>${logo}</div>
      <p>Dear ${doc.ExtUserPtr.Name},</p>
      <p>${doc.Name} has been signed by ${signUser.Name} (${signUser.Email}).</p>
      <p><a href="${viewDocUrl}">View Document</a></p>
      <p>This is an automated email from ${TenantAppName}.</p>
      </body></html>`;
    await axios.post(
      `${serverUrl}/functions/sendmailv3`,
      { extUserId: doc.ExtUserPtr.objectId, from: TenantAppName, recipient: doc.ExtUserPtr.Email, subject, html: body, mailProvider },
      { headers: { 'Content-Type': 'application/json', 'X-Parse-Application-Id': APPID, 'X-Parse-Master-Key': masterKEY } }
    );
  } catch (err) {
    console.log('Err in sendNotifyMail:', err);
  }
}

// Send completion email and save certificate
async function sendMailsaveCertifcate(doc, pfx, isCustomMail, mailProvider, filename) {
  const certificate = await GenerateCertificate(doc);
  const certPdf = await PDFDocument.load(certificate);
  pdflibAddPlaceholder({ pdfDoc: certPdf, reason: `Digitally signed by ${eSignName}`, location: 'n/a', name: eSignName, contactInfo: eSigncontact, signatureLength: 15000 });
  const certBytes = await certPdf.save();
  const certPath = `./exports/signed_certificate_${doc.objectId}.pdf`;
  fs.writeFileSync(certPath, certBytes);
  const { imageUrl } = await uploadFile('certificate.pdf', certPath);
  await axios.put(
    `${serverUrl}/classes/contracts_Document/${doc.objectId}`,
    { CertificateUrl: imageUrl },
    { headers: { 'Content-Type': 'application/json', 'X-Parse-Application-Id': APPID, 'X-Parse-Master-Key': masterKEY } }
  );
  if (doc.IsSendMail !== false) {
    sendCompletedMail({ isCustomMail, doc, mailProvider, filename });
  }
  saveFileUsage(certBytes.length, imageUrl, doc.CreatedBy?.objectId);
  unlinkFile(pfx.name);
}

/**
 * Handles digital signing PDF via Cloud Function
 */
async function PDF(req) {
  // 1. Determine or create Document record
  let resDoc;
  if (req.params.docId) {
    const query = new Parse.Query('contracts_Document');
    query.include('ExtUserPtr,Signers,ExtUserPtr.TenantId,Bcc,Placeholders');
    query.equalTo('objectId', req.params.docId);
    resDoc = await query.first({ useMasterKey: true });
    if (!resDoc) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');
    }
  } else {
    const DocClass = Parse.Object.extend('contracts_Document');
    resDoc = new DocClass();
    resDoc.set('Name', req.params.title || 'Self Signed Document');
    resDoc.set('URL', `data:application/pdf;base64,${req.params.pdfFile}`);
    await resDoc.save(null, { useMasterKey: true });
  }

  // 2. Load PDF buffer (direct or from stored URL)
  let PdfBuffer;
  if (req.params.pdfFile) {
    PdfBuffer = Buffer.from(req.params.pdfFile, 'base64');
  } else {
    const pdfUrl = resDoc.get('URL');
    const response = await Parse.Cloud.httpRequest({ url: pdfUrl });
    PdfBuffer = Buffer.from(response.buffer);
  }

  // 3. Prepare signature params
  const randomNumber = Math.floor(Math.random() * 5000);
  const pfxname = `keystore_${randomNumber}.pfx`;
  const sign = req.params.signature;
  let pfxFile = process.env.PFX_BASE64;
  let passphrase = process.env.PASS_PHRASE;
  if (resDoc.get('ExtUserPtr')?.TenantId?.PfxFile?.base64) {
    pfxFile = resDoc.get('ExtUserPtr').TenantId.PfxFile.base64;
    passphrase = resDoc.get('ExtUserPtr').TenantId.PfxFile.password;
  }
  const P12Buffer = Buffer.from(pfxFile, 'base64');
  fs.writeFileSync(pfxname, P12Buffer);

  // 4. Sign PDF using pdf-lib + signpdf
  const pdfDoc = await PDFDocument.load(PdfBuffer);
  pdfDoc.getForm().updateFieldAppearances();
  pdfDoc.getForm().flatten();
  Placeholder({ pdfDoc, reason: `Digitally signed by ${eSignName}`, location: 'n/a', name: eSignName, contactInfo: eSigncontact, signatureLength: 15000 });
  const pdfBytesWithPlaceholder = await pdfDoc.save();
  const signer = new P12Signer(P12Buffer, { passphrase });
  const signedBinary = await new SignPdf().sign(Buffer.from(pdfBytesWithPlaceholder), signer);
  const signedPath = `./exports/signed_${resDoc.id}_${randomNumber}.pdf`;
  fs.writeFileSync(signedPath, signedBinary);

  // 5. Upload signed PDF and update record
  const { imageUrl } = await uploadFile(`signed_${resDoc.id}.pdf`, signedPath);
  const updateRes = await updateDoc(resDoc.id, imageUrl, req.params.userId, req.headers['x-real-ip'], resDoc.toJSON(), req.params.className, sign);
  sendNotifyMail(resDoc.toJSON(), req.params.userId, req.params.mailProvider, req.headers.public_url);
  saveFileUsage(signedBinary.length, imageUrl, resDoc.get('CreatedBy').objectId);

  // 6. If fully signed, send completion cert & mail
  if (updateRes.isCompleted) {
    sendMailsaveCertifcate(resDoc.toJSON(), { name: pfxname, passphrase }, req.params.isCustomCompletionMail, req.params.mailProvider, signedPath);
  } else {
    unlinkFile(pfxname);
  }
  unlinkFile(signedPath);

  return { status: 'success', data: imageUrl };
}

export default PDF;
