// Minimal MPEG-TS muxer with PAT/PMT so Chromium's demuxer can find the stream.
// Video-only H.264; one PES per access unit (one VideoEncoder chunk).
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let b = 0; b < 8; b++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c;
  }
  return t;
})();

// MPEG-2 CRC-32: no final XOR (unlike the usual CRC-32). Verified against a
// real segment's PAT: 2ab104b2 matches only without the final inversion.
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

const VIDEO_PID = 0x100;
const PMT_PID = 0x1000;

function pat() {
  // pointer_field(1) | table_id(1) | flags(1) | section_length(1) |
  // transport_stream_id(2) | version/current_next(1) | section_number(1) |
  // last_section_number(1) | program_number(2) | reserved+PMT_PID(2) | CRC32(4)
  const b = Buffer.alloc(17);
  b[0] = 0x00; // pointer_field
  b[1] = 0x00; // table_id
  b[2] = 0xb0; // section_syntax_indicator + reserved
  b[3] = 0x0d; // section_length = 13
  b.writeUInt16BE(0x0001, 4); // transport_stream_id
  b[6] = 0xc1; // version + current_next_indicator
  b[7] = 0x00; // section_number
  b[8] = 0x00; // last_section_number
  b.writeUInt16BE(0x0001, 9); // program_number
  b[11] = 0xe0 | ((PMT_PID >> 8) & 0x1f);
  b[12] = PMT_PID & 0xff;
  b.writeUInt32BE(crc32(b.subarray(1, 13)), 13);
  return b;
}

function pmt() {
  // pointer_field(1) | table_id(1) | flags+len_hi(1) | len_lo(1) |
  // program_number(2) | version/current_next(1) | section_number(1) |
  // last_section_number(1) | reserved+PCR_PID(2) | reserved+program_info_length(2) |
  // stream_type(1) | reserved+elementary_PID(2) | reserved+ES_info_length(2) | CRC32(4)
  const b = Buffer.alloc(22);
  b[0] = 0x00; // pointer_field
  b[1] = 0x02; // table_id
  b[2] = 0xb0;
  b[3] = 0x12; // section_length = 18
  b.writeUInt16BE(0x0001, 4); // program_number
  b[6] = 0xc1; // version + current_next_indicator
  b[7] = 0x00; // section_number
  b[8] = 0x00; // last_section_number
  b[9] = 0xe0 | ((VIDEO_PID >> 8) & 0x1f);
  b[10] = VIDEO_PID & 0xff;
  b.writeUInt16BE(0xf000, 11); // reserved + program_info_length
  b[13] = 0x1b; // stream_type: H.264
  b[14] = 0xe0 | ((VIDEO_PID >> 8) & 0x1f);
  b[15] = VIDEO_PID & 0xff;
  b.writeUInt16BE(0xf000, 16); // reserved + ES_info_length
  b.writeUInt32BE(crc32(b.subarray(1, 18)), 18);
  return b;
}

function tsPacket(payload, { pid, pusi, cc, pcr }) {
  const pkt = Buffer.alloc(188);
  pkt[0] = 0x47;
  pkt[1] = ((pid >> 8) & 0x1f) | (pusi ? 0x40 : 0);
  pkt[2] = pid & 0xff;
  pkt[3] = (cc & 0x0f) | 0x10; // payload present, adaptation_field_control = payload only
  if (pcr !== undefined) {
    pkt[3] = (cc & 0x0f) | 0x30; // adaptation field + payload
    pkt[4] = 0x07; // adaptation_field_length
    pkt[5] = 0x10; // PCR flag
    pkt[6] = (pcr >>> 25) & 0xff;
    pkt[7] = (pcr >>> 17) & 0xff;
    pkt[8] = (pcr >>> 9) & 0xff;
    pkt[9] = (pcr >>> 1) & 0xff;
    pkt[10] = ((pcr & 1) << 7) | 0x7e;
    pkt[11] = 0x00; // extension
    payload.copy(pkt, 12);
  } else {
    payload.copy(pkt, 4);
  }
  return pkt;
}

/**
 * @param {Buffer[]} accessUnits Annex B H.264 access units (one per frame)
 * @param {number} fps
 * @param {number} startFrame index of the first frame (so a segment's PTS
 *   continues where the previous segment ended)
 */
function mux(accessUnits, fps, startFrame = 0) {
  const out = [];
  let ccPat = 0;
  let ccPmt = 0;
  let ccVid = 0;
  out.push(tsPacket(pat(), { pid: 0, pusi: true, cc: ccPat++ }));
  out.push(tsPacket(pmt(), { pid: PMT_PID, pusi: true, cc: ccPmt++ }));

  accessUnits.forEach((au, i) => {
    const pts = 90 * 1000 + Math.round(((i + startFrame) * 90000) / fps);
    const pesHeader = Buffer.alloc(14);
    pesHeader.writeUInt8(0x00, 0);
    pesHeader.writeUInt8(0x00, 1);
    pesHeader.writeUInt8(0x01, 2);
    pesHeader.writeUInt8(0xe0, 3); // video stream
    pesHeader.writeUInt16BE(0, 4); // length 0 (allowed for video)
    pesHeader.writeUInt8(0x80, 6); // '10' marker: PTS only
    pesHeader.writeUInt8(0x80, 7); // PTS_DTS_flags = '10'
    pesHeader.writeUInt8(0x05, 8); // PES_header_data_length
    pesHeader.writeUInt8(0x20 | ((pts >> 29) & 0x0e) | 1, 9);
    pesHeader.writeUInt8((pts >> 22) & 0xff, 10);
    pesHeader.writeUInt8(((pts >> 14) & 0xfe) | 1, 11);
    pesHeader.writeUInt8((pts >> 7) & 0xff, 12);
    pesHeader.writeUInt8(((pts << 1) & 0xfe) | 1, 13);
    const pes = Buffer.concat([pesHeader, au]);

    let off = 0;
    let first = true;
    while (off < pes.length) {
      // A PCR-carrying packet spends 8 bytes on the adaptation field, so it holds
      // less payload; slicing must follow the packet's actual header size.
      const headerSize = first ? 12 : 4;
      const chunk = pes.subarray(off, off + (188 - headerSize));
      out.push(
        tsPacket(chunk, {
          pid: VIDEO_PID,
          pusi: first,
          cc: ccVid++,
          pcr: first ? pts : undefined,
        }),
      );
      off += chunk.length;
      first = false;
    }
  });
  return Buffer.concat(out);
}

module.exports = { mux, crc32 };
