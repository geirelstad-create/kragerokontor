import PDFDocument from 'pdfkit';

export type ReceiptData = {
  receiptLabel: string;        // f.eks. KVITT-2026-1000
  receiptDate: Date;
  room: string;
  mode: string;                // day | week | month
  startDate: string;           // YYYY-MM-DD
  endDate: string | null;
  label: string | null;        // f.eks. "1 uke", "3 dager"
  amountNok: number;
  customerName: string;
  customerCompany: string | null;
  customerOrgNo: string | null;
  customerEmail: string;
  paymentMethod: string;       // card | vipps | invoice
};

const SELLER = {
  name: 'Quad AS',
  address: 'Fjordalléen 16',
  zipCity: '0250 Oslo',
  orgno: '881 952 882',
  email: 'post@quad.no',
};

function nok(n: number) {
  return new Intl.NumberFormat('nb-NO').format(n) + ',00 kr';
}

function prettyDate(d: Date) {
  return new Intl.DateTimeFormat('nb-NO', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

function periodText(r: ReceiptData) {
  if (r.endDate && r.endDate !== r.startDate) return `${r.startDate} – ${r.endDate}`;
  return r.startDate;
}

function paymentText(method: string) {
  if (method === 'vipps') return 'Vipps';
  if (method === 'invoice') return 'Faktura';
  return 'Betalingskort';
}

/**
 * Genererer en kvitterings-PDF og returnerer den som en Buffer.
 * Kvitteringen er ment som regnskapsbilag for betalt booking.
 */
export function generateReceiptPdf(r: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = 56;
      const right = 539; // A4 width 595 - margin
      const accent = '#3a2df0';

      // ---- Topp: tittel + selger ----
      doc.fillColor(accent).fontSize(22).font('Helvetica-Bold').text('KVITTERING', left, 56);
      doc.fillColor('#111').fontSize(10).font('Helvetica');

      doc.font('Helvetica-Bold').fontSize(13).fillColor('#111')
        .text(SELLER.name, right - 200, 58, { width: 200, align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor('#444')
        .text(SELLER.address, right - 200, 76, { width: 200, align: 'right' })
        .text(SELLER.zipCity, right - 200, 90, { width: 200, align: 'right' })
        .text(`Org.nr ${SELLER.orgno}`, right - 200, 104, { width: 200, align: 'right' })
        .text(SELLER.email, right - 200, 118, { width: 200, align: 'right' });

      // ---- Kvitteringsinfo ----
      let y = 150;
      doc.moveTo(left, y).lineTo(right, y).strokeColor('#e3e0d8').lineWidth(1).stroke();
      y += 16;

      doc.fillColor('#666').font('Helvetica').fontSize(9);
      doc.text('KVITTERINGSNUMMER', left, y);
      doc.text('KVITTERINGSDATO', left + 200, y);
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(11);
      doc.text(r.receiptLabel, left, y + 12);
      doc.text(prettyDate(r.receiptDate), left + 200, y + 12);

      // ---- Kjøper ----
      y += 44;
      doc.fillColor('#666').font('Helvetica').fontSize(9).text('FAKTURERT TIL', left, y);
      y += 13;
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text(r.customerName, left, y);
      y += 15;
      doc.font('Helvetica').fontSize(10).fillColor('#444');
      if (r.customerCompany) { doc.text(r.customerCompany, left, y); y += 14; }
      if (r.customerOrgNo) { doc.text(`Org.nr ${r.customerOrgNo}`, left, y); y += 14; }
      doc.text(r.customerEmail, left, y); y += 14;

      // ---- Linjetabell ----
      y += 20;
      const colDesc = left;
      const colAmt = right - 120;
      doc.fillColor('#666').font('Helvetica').fontSize(9);
      doc.text('BESKRIVELSE', colDesc, y);
      doc.text('BELØP', colAmt, y, { width: 120, align: 'right' });
      y += 14;
      doc.moveTo(left, y).lineTo(right, y).strokeColor('#e3e0d8').lineWidth(1).stroke();
      y += 12;

      const desc = `Leie av ${r.room}`;
      const sub = `${r.label ?? ''}${r.label ? ' · ' : ''}${periodText(r)}`;
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text(desc, colDesc, y, { width: 320 });
      doc.font('Helvetica').fontSize(11).text(nok(r.amountNok), colAmt, y, { width: 120, align: 'right' });
      y += 16;
      doc.fillColor('#666').font('Helvetica').fontSize(9).text(sub, colDesc, y, { width: 320 });

      // ---- Sum ----
      y += 30;
      doc.moveTo(colAmt - 60, y).lineTo(right, y).strokeColor('#e3e0d8').lineWidth(1).stroke();
      y += 12;
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(13).text('Totalt betalt', colAmt - 160, y, { width: 160, align: 'left' });
      doc.text(nok(r.amountNok), colAmt, y, { width: 120, align: 'right' });

      // ---- Mva-merknad + betalt ----
      y += 34;
      doc.fillColor('#444').font('Helvetica').fontSize(9)
        .text('Utleie av fast eiendom – unntatt merverdiavgift, jf. merverdiavgiftsloven § 3-11.', left, y, { width: right - left });
      y += 18;
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(10)
        .text(`Betalt med ${paymentText(r.paymentMethod)} – beløpet er mottatt.`, left, y, { width: right - left });

      // ---- Footer ----
      doc.fillColor('#999').font('Helvetica').fontSize(8)
        .text(`${SELLER.name} · ${SELLER.address}, ${SELLER.zipCity} · Org.nr ${SELLER.orgno} · ${SELLER.email}`,
          left, 760, { width: right - left, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
