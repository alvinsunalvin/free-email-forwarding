const dns = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const Client = require('nodemailer/lib/smtp-connection');
const IORedis = require('ioredis');
const _ = require('lodash');
const bytes = require('bytes');
const domains = require('disposable-email-domains');
const getPort = require('get-port');
const isCI = require('is-ci');
const nodemailer = require('nodemailer');
const shell = require('shelljs');
const test = require('ava');
const uuid = require('uuid');

const lookupAsync = util.promisify(dns.lookup);

const ForwardEmail = require('..');

const tls = { rejectUnauthorized: false };

const client = new IORedis();

test.beforeEach(async t => {
  const keys = await client.keys('limit:*');
  if (keys.length > 0) await Promise.all(keys.map(key => client.del(key)));
  const port = await getPort();
  const forwardEmail = new ForwardEmail({ port });
  await forwardEmail.listen();
  t.context.forwardEmail = forwardEmail;
});

test.afterEach(async t => {
  await t.context.forwardEmail.close();
});

test('returns itself', t => {
  t.true(new ForwardEmail() instanceof ForwardEmail);
});

test('binds context', t => {
  t.true(t.context.forwardEmail instanceof ForwardEmail);
});

test.cb('rejects auth connections', t => {
  const { port } = t.context.forwardEmail.server.address();
  const connection = new Client({ port, tls });
  connection.once('end', t.end);
  connection.connect(() => {
    connection.login({ user: 'user', pass: 'pass' }, err => {
      t.is(err.responseCode, 500);
      connection.close();
    });
  });
});

test('verifies connection', async t => {
  const { port } = t.context.forwardEmail.server.address();
  const transporter = nodemailer.createTransport({ port, tls });
  await transporter.verify();
  t.pass();
});

/*
test('rejects forwarding a non-FQDN email', async t => {
  const transporter = nodemailer.createTransport({
    streamTransport: true
  });
  const { port } = t.context.forwardEmail.server.address();
  const connection = new Client({  port, tls });
  const info = await transporter.sendMail({
    from: 'ForwardEmail <from@forwardemail.net>',
    to: 'Niftylettuce <hello@127.0.0.1>',
    subject: 'test',
    text: 'test text',
    html: '<strong>test html</strong>',
    attachments: []
  });
  return new Promise(resolve => {
    connection.once('end', resolve);
    connection.connect(() => {
      connection.send(info.envelope, info.message, err => {
        t.is(err.responseCode, 550);
        t.regex(err.message, /is not a fully qualified domain name/);
        connection.close();
      });
    });
  });
});
*/

// test('rejects forwarding a non-registered email domain', async t => {
//   t.regex(err.message, /does not have a valid forwardemail TXT record/);
// });

test('rejects forwarding a non-registered email address', async t => {
  const transporter = nodemailer.createTransport({
    streamTransport: true
  });
  const { port } = t.context.forwardEmail.server.address();
  const connection = new Client({ port, tls });
  const info = await transporter.sendMail({
    from: 'ForwardEmail <from@forwardemail.net>',
    to: 'Niftylettuce <fail@test.niftylettuce.com>', // "pass" works
    subject: 'test',
    text: 'test text',
    html: '<strong>test html</strong>',
    attachments: []
  });
  return new Promise(resolve => {
    connection.once('end', resolve);
    connection.connect(() => {
      connection.send(info.envelope, info.message, err => {
        t.is(err.responseCode, 550);
        t.regex(
          err.message,
          /is not configured properly and does not contain any valid/
        );
        connection.close();
      });
    });
  });
});

if (!isCI)
  test('forwards an email with DKIM and SPF', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: 'ForwardEmail <from@forwardemail.net>',
      to: 'Niftylettuce <hello@niftylettuce.com>',
      cc: 'cc@niftylettuce.com',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>',
      attachments: [],
      dkim: t.context.forwardEmail.config.dkim
    });
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err, null);
          connection.close();
        });
      });
    });
  });

if (!isCI)
  test('rejects forwarding an email with max forwarding addresses exceeded', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: 'ForwardEmail <from@forwardemail.net>',
      to: '1@niftylettuce.com',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>',
      attachments: [],
      dkim: t.context.forwardEmail.config.dkim
    });
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err.responseCode, 550);
          t.regex(err.message, /addresses which exceeds the maximum/);
          connection.close();
        });
      });
    });
  });

if (!isCI)
  test('rejects forwarding an email with recursive max forwarding addresses exceeded', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: 'ForwardEmail <from@forwardemail.net>',
      to: '2@niftylettuce.com',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>',
      attachments: [],
      dkim: t.context.forwardEmail.config.dkim
    });
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err.responseCode, 550);
          t.regex(err.message, /addresses which exceeds the maximum/);
          connection.close();
        });
      });
    });
  });

if (!isCI)
  test('forwards an email with DKIM and SPF without recursive loop', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: 'from@forwardemail.net',
      to: [
        'test@niftylettuce.com',
        'admin@niftylettuce.com',
        'hello@niftylettuce.com',
        'hello+test@niftylettuce.com',
        'test+hello@niftylettuce.com'
      ],
      subject: 'forwards an email without recursive loop',
      text: 'test text',
      html: '<strong>test html</strong>',
      attachments: [],
      dkim: t.context.forwardEmail.config.dkim
    });
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err, null);
          connection.close();
        });
      });
    });
  });

if (!isCI)
  test('rejects sending to one invalid recipient', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: 'ForwardEmail <from@forwardemail.net>',
      to: 'Niftylettuce <admin@niftylettuce.com>, oops@localhost',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>',
      attachments: [],
      dkim: t.context.forwardEmail.config.dkim
    });
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, (err, response) => {
          t.is(err, null);
          t.is(response.accepted.length, 1);
          t.is(response.rejected.length, 1);
          connection.close();
        });
      });
    });
  });

if (!isCI)
  test('forwards an email with DKIM and SPF to domain aliased recipients', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: 'ForwardEmail <from@forwardemail.net>',
      // a@cabinjs.com -> a@lipo.io -> niftylettuce+a@gmail.com
      to: 'Alias <a@cabinjs.com>',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>',
      attachments: [],
      dkim: t.context.forwardEmail.config.dkim
    });
    /*
    t.deepEqual(info.envelope, ['niftylettuce@gmail.com']);
    */
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err, null);
          connection.close();
        });
      });
    });
  });

if (!isCI)
  test('forwards an email with DKIM and SPF to global recipients', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: 'ForwardEmail <from@forwardemail.net>',
      to: 'Niftylettuce <admin@niftylettuce.com>',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>',
      attachments: [],
      dkim: t.context.forwardEmail.config.dkim
    });
    /*
    t.deepEqual(info.envelope, ['niftylettuce@gmail.com']);
    */
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err, null);
          connection.close();
        });
      });
    });
  });

if (!isCI)
  test('forwards an email with DKIM and SPF to multiple recipients', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: 'ForwardEmail <from@forwardemail.net>',
      to: 'Niftylettuce <hello@niftylettuce.com>',
      cc: 'cc@niftylettuce.com',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>',
      attachments: [],
      dkim: t.context.forwardEmail.config.dkim
    });
    /*
    t.deepEqual(info.envelope, [
      'nicholasbaugh@gmail.com',
      'niftylettuce+a@gmail.com',
      'niftylettuce+b@gmail.com',
      'niftylettuce@gmail.com'
    ]);
    */
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err, null);
          connection.close();
        });
      });
    });
  });

if (!isCI)
  test('forwards an email with DKIM and SPF and a comma in the FROM', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: '"Doe, John" <john.doe@lipo.io>',
      to: 'Niftylettuce <hello@niftylettuce.com>',
      cc: 'cc@niftylettuce.com',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>',
      attachments: [],
      dkim: t.context.forwardEmail.config.dkim
    });
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err, null);
          connection.close();
        });
      });
    });
  });

if (!isCI && shell.which('spamassassin') && shell.which('spamc'))
  test('rejects a spam file', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });

    const info = await transporter.sendMail({
      from: 'foo@forwardemail.net',
      to: 'Baz <baz@forwardemail.net>',
      // taken from:
      // <https://github.com/humantech/node-spamd/blob/master/test/spamd-tests.js#L13-L14>
      subject: 'Viagra, Cialis, Vicodin: buy medicines without prescription!',
      html: 'Cheap prices on viagra, cialis, vicodin! FPA approved!',
      dkim: t.context.forwardEmail.config.dkim
    });
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err.responseCode, 551);
          t.regex(err.message, /Message detected as spam/);
          connection.close();
        });
      });
    });
  });

test('creates 100 simultaneous connections (w/o rate limiting)', async t => {
  const forwardEmail = new ForwardEmail({ limiter: false });
  const port = await getPort();
  forwardEmail.server.listen(port);
  await Promise.all(
    _.range(100).map(async () => {
      const connection = new Client({ port, tls });
      const transporter = nodemailer.createTransport({
        streamTransport: true
      });
      const info = await transporter.sendMail({
        from: 'foo@forwardemail.net',
        to: 'Baz <no-reply@forwardemail.net>',
        subject: 'test',
        text: 'test text',
        html: '<strong>test text</strong>'
      });
      return new Promise((resolve, reject) => {
        connection.once('error', reject);
        connection.once('end', resolve);
        connection.connect(() => {
          connection.send(info.envelope, info.message, err => {
            t.is(err.responseCode, 550);
            t.regex(err.message, /You need to reply/);
            connection.close();
          });
        });
      });
    })
  );
  t.pass();
});

test('rejects a file over the limit', async t => {
  const transporter = nodemailer.createTransport({
    streamTransport: true
  });
  const filePath = path.join(os.tmpdir(), uuid());
  const size = bytes('26mb');
  const { port } = t.context.forwardEmail.server.address();
  const connection = new Client({ port, tls });
  const fh = fs.openSync(filePath, 'w');
  fs.writeSync(fh, 'ok', size);
  const info = await transporter.sendMail({
    from: 'foo@forwardemail.net',
    to: 'Baz <baz@forwardemail.net>',
    subject: 'test',
    text: 'test text',
    html: '<strong>test text</strong>',
    attachments: [{ path: filePath }]
  });
  return new Promise(resolve => {
    connection.once('end', resolve);
    connection.connect(() => {
      connection.send(info.envelope, info.message, err => {
        t.is(err.responseCode, 552);
        t.regex(
          err.message,
          new RegExp(
            `Maximum allowed message size ${bytes(
              t.context.forwardEmail.config.smtp.size
            )} exceeded`,
            'g'
          )
        );
        fs.unlinkSync(filePath);
        connection.close();
      });
    });
  });
});

if (!isCI)
  test('rejects and accepts at same time', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: 'foo@forwardemail.net',
      to: 'Niftylettuce <hello@niftylettuce.com>, no-reply@forwardemail.net',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>',
      dkim: t.context.forwardEmail.config.dkim
    });
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err.responseCode, 550);
          connection.close();
        });
      });
    });
  });

test('rejects a disposable email sender', async t => {
  const transporter = nodemailer.createTransport({
    streamTransport: true
  });
  const { port } = t.context.forwardEmail.server.address();
  const connection = new Client({ port, tls });
  const info = await transporter.sendMail({
    from: `disposable@${domains[0]}`,
    to: 'Niftylettuce <hello@niftylettuce.com>',
    subject: 'test',
    text: 'test text',
    html: '<strong>test html</strong>'
  });
  return new Promise(resolve => {
    connection.once('end', resolve);
    connection.connect(() => {
      connection.send(info.envelope, info.message, err => {
        t.is(err.responseCode, 550);
        t.regex(err.message, /is not permitted/);
        connection.close();
      });
    });
  });
});

test('rejects an email to no-reply@forwardemail.net', async t => {
  const transporter = nodemailer.createTransport({
    streamTransport: true
  });
  const { port } = t.context.forwardEmail.server.address();
  const connection = new Client({ port, tls });
  const info = await transporter.sendMail({
    from: 'foo@forwardemail.net',
    to: 'Niftylettuce <no-reply@forwardemail.net>',
    subject: 'test',
    text: 'test text',
    html: '<strong>test html</strong>'
  });
  return new Promise(resolve => {
    connection.once('end', resolve);
    connection.connect(() => {
      connection.send(info.envelope, info.message, err => {
        t.is(err.responseCode, 550);
        t.regex(
          err.message,
          /You need to reply to the "Reply-To" email address on the email; do not send messages to <no-reply@forwardemail.net>/
        );
        connection.close();
      });
    });
  });
});

test('ForwardEmail is not in DNS blacklists', async t => {
  const ips = await Promise.all([
    lookupAsync('forwardemail.net'),
    lookupAsync('mx1.forwardemail.net'),
    lookupAsync('mx2.forwardemail.net')
  ]);
  const [domain, mx1, mx2] = await Promise.all(
    ips.map(ip => t.context.forwardEmail.checkBlacklists(ip.address))
  );
  t.is(domain, false);
  t.is(mx1, false);
  t.is(mx2, false);
});

if (!isCI)
  test('disabled emails are delivered to blackhole', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();
    const connection = new Client({ port, tls });
    const info = await transporter.sendMail({
      from: '"Doe, John" <john.doe@forwardemail.net>',
      to: 'disabled@niftylettuce.com',
      subject: 'test',
      text: 'test text',
      html: '<strong>test html</strong>'
    });
    return new Promise(resolve => {
      connection.once('end', resolve);
      connection.connect(() => {
        connection.send(info.envelope, info.message, err => {
          t.is(err, null);
          connection.close();
        });
      });
    });
  });

/*
test.todo('rejects invalid DKIM signature');
test.todo('accepts valid DKIM signature');
test.todo('rejects invalid SPF');
test.todo('accepts valid SPF');
test.todo('supports + symbol aliased onRcptTo');
test.todo('preserves charset');
test.tood('graceful shutdown');

if (!isCI)
  test('prevents spam through rate limiting', async t => {
    const transporter = nodemailer.createTransport({
      streamTransport: true
    });
    const { port } = t.context.forwardEmail.server.address();

    let failed = 0;

    await Promise.all(
      Array.from(Array(200).keys()).map(() => {
        return new Promise(async (resolve, reject) => {
          try {
            const info = await transporter.sendMail({
              from: 'foo@forwardemail.net',
              to: 'Baz <baz@forwardemail.net>',
              subject: 'test',
              text: 'test text',
              html: '<strong>test html</strong>',
              dkim: t.context.forwardEmail.config.dkim
            });
            const connection = new Client({  port, tls });
            connection.once('end', resolve);
            connection.connect(() => {
              connection.send(info.envelope, info.message, err => {
                if (err && err.responseCode === 451) failed++;
                connection.close();
              });
            });
          } catch (err) {
            reject(err);
          }
        });
      })
    );

    t.is(failed, 100);
  });
*/
