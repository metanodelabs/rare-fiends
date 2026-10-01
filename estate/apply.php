<?php
// Where a project application lands.
//
// The form posts JSON here and each application is appended, one per line, to a file that sits ONE LEVEL
// ABOVE the document root, so it is never servable no matter what happens to the site directory:
//
//     /var/www/rarefiends/applications.jsonl      <- written here
//     /var/www/rarefiends/site/                   <- everything the public can fetch
//
// Read them with:  ssh root@<host> "cat /var/www/rarefiends/applications.jsonl"
//
// Nothing here trusts the browser: every field is checked for presence, capped for length, and written
// through json_encode, so a submission can neither blow up the file nor smuggle a line break into it.

declare(strict_types=1);

// Never let PHP talk to the browser. A warning or a fatal printed into the response leaks the file path
// and turns a JSON reply into something the form cannot read.
ini_set('display_errors', '0');
ini_set('log_errors', '1');

// mbstring is not installed here, and for a length cap bytes are the safer measure anyway: it is the file
// that has to be protected, not a character count.
function len(string $v): int { return function_exists('mb_strlen') ? mb_strlen($v) : strlen($v); }

const STORE   = '/var/www/rarefiends/applications.jsonl';
const RATE    = '/var/www/rarefiends/apply-rate.json';
const MAX_BODY = 8192;        // a form this size cannot honestly need more
const PER_HOUR = 5;           // applications accepted from one address per hour

header('Content-Type: application/json');
header('Cache-Control: no-store');

function stop(int $code, string $why): never {
    http_response_code($code);
    // the reason is a fixed string, never anything the caller sent back to them
    echo json_encode(['ok' => false, 'error' => $why]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') stop(405, 'post only');
if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_BODY) stop(413, 'too long');

$raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
if ($raw === false || strlen($raw) > MAX_BODY) stop(413, 'too long');

$in = json_decode($raw, true);
if (!is_array($in)) stop(400, 'bad json');

// A field the form keeps off screen. A person never fills it in; a bot fills in everything it finds, so
// anything arriving with it set is dropped - and told it succeeded, which is what stops it retrying.
if (trim((string)($in['website'] ?? '')) !== '') { echo json_encode(['ok' => true]); exit; }

$fields = [
    'name'     => 80,
    'chain'    => 40,
    'supply'   => 20,
    'onchain'  => 3,
    'contract' => 120,
    'traits'   => 1200,
    'link'     => 300,
    'contact'  => 80,
];
$rec = [];
foreach ($fields as $key => $max) {
    $v = trim((string)($in[$key] ?? ''));
    if ($v === '') stop(400, 'missing ' . $key);
    if (len($v) > $max) stop(400, 'too long: ' . $key);
    $rec[$key] = $v;
}
if (!in_array($rec['onchain'], ['yes', 'no'], true)) stop(400, 'bad onchain');

// Rate limit by address, so one person cannot fill the file on their own.
$ip = (string)($_SERVER['REMOTE_ADDR'] ?? '?');
$now = time();
$seen = is_readable(RATE) ? json_decode((string)file_get_contents(RATE), true) : [];
if (!is_array($seen)) $seen = [];
$mine = array_values(array_filter($seen[$ip] ?? [], fn($t) => $now - (int)$t < 3600));
if (count($mine) >= PER_HOUR) stop(429, 'too many');
$mine[] = $now;
$seen[$ip] = $mine;
foreach ($seen as $k => $ts) {                       // forget addresses that have gone quiet
    $keep = array_values(array_filter($ts, fn($t) => $now - (int)$t < 3600));
    if ($keep) $seen[$k] = $keep; else unset($seen[$k]);
}
@file_put_contents(RATE, json_encode($seen), LOCK_EX);

$rec['at'] = gmdate('c');
$rec['ip'] = $ip;
$line = json_encode($rec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
if ($line === false) stop(400, 'bad encoding');

if (@file_put_contents(STORE, $line . "\n", FILE_APPEND | LOCK_EX) === false) stop(500, 'could not save');

echo json_encode(['ok' => true]);
