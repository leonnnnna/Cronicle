#!/usr/bin/env node

// Enhanced URL Plugin for Cronicle
// Supports {变量} [now] [now:格式] {=js表达式} 占位符自动替换

var fs = require('fs');
var os = require('os');
var path = require('path');
var JSONStream = require('pixl-json-stream');
var Request = require('pixl-request');
var dayjs = null;
try { dayjs = require('dayjs'); } catch(e) {}

// setup stdin / stdout streams 
process.stdin.setEncoding('utf8');
process.stdout.setEncoding('utf8');

var stream = new JSONStream( process.stdin, process.stdout );
stream.on('json', function(job) {
	var params = job.params || {};
	var request = new Request();

	// 合并 job 级所有参数
	var allParams = Object.assign({}, job, job.params || {});

	var print = function(text) {
		fs.appendFileSync( job.log_file, text );
	};

	// 变量替换核心函数
	function substitute(str) {
		if (!str) return '';
		// 替换 {变量}
		str = str.replace(/\{([a-zA-Z0-9_]+)\}/g, function(_, key) {
			return (allParams[key] != null) ? allParams[key] : '';
		});
		// 替换 [now]、[now:格式]
		str = str.replace(/\[now(?::([^\]]+))?\]/g, function(_, fmt) {
			let d = new Date();
			if (!fmt) return Math.floor(d.getTime() / 1000);
			if (dayjs) {
				try { return dayjs().format(fmt); } catch (e) {}
			}
			// 简单内置格式
			if (fmt === 'YYYY-MM-DD HH:mm:ss') {
				return d.getFullYear()+'-'+(d.getMonth()+1).toString().padStart(2,'0')+'-'+d.getDate().toString().padStart(2,'0')+' '+
					d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+':'+d.getSeconds().toString().padStart(2,'0');
			}
			return d.toLocaleString();
		});
		// 替换 {=js表达式}
		str = str.replace(/\{\=\s*([^}]+)\}/g, function(_, expr) {
			try {
				let result = eval(expr);
				return (typeof result === 'undefined') ? '' : result;
			} catch(e) { return ''; }
		});
		return str;
	}

	// timeout
	request.setTimeout( (params.timeout || 0) * 1000 );

	// url
	if (!params.url || !params.url.match(/^https?\:\/\/\S+$/i)) {
		stream.write({ complete: 1, code: 1, description: "Malformed URL: " + (params.url || '(n/a)') });
		return;
	}
	params.url = substitute(params.url);
	print("Sending HTTP " + params.method + " to URL:\n" + params.url + "\n");

	// headers
	if (params.headers) {
		params.headers = substitute(params.headers);
		print("\nRequest Headers:\n" + params.headers.trim() + "\n");
		params.headers.replace(/\r\n/g, "\n").trim().split(/\n/).forEach( function(pair) {
			if (pair.match(/^([^\:]+)\:\s*(.+)$/)) {
				request.setHeader( substitute(RegExp.$1), substitute(RegExp.$2) );
			}
		});
	}

	// follow redirects
	if (params.follow) request.setFollow( 32 );

	var opts = {
		method: params.method
	};

	// ssl cert bypass
	if (params.ssl_cert_bypass) {
		opts.rejectUnauthorized = false;
	}

	// post data
	if (opts.method == 'POST') {
		params.data = substitute(params.data);
		print("\nPOST Data:\n" + params.data.trim() + "\n");
		opts.data = Buffer.from( params.data || '' );
	}

	// matching
	var success_match = new RegExp( params.success_match || '.*' );
	var error_match = new RegExp( params.error_match || '(?!)' );

	// send request
	request.request( params.url, opts, function(err, resp, data, perf) {
		if (!err && ((resp.statusCode < 200) || (resp.statusCode >= 400))) {
			err = new Error("HTTP " + resp.statusCode + " " + resp.statusMessage);
			err.code = resp.statusCode;
		}
		var text = data ? data.toString() : '';
		if (!err) {
			if (text.match(error_match)) {
				err = new Error("Response contains error match: " + params.error_match);
			}
			else if (!text.match(success_match)) {
				err = new Error("Response missing success match: " + params.success_match);
			}
		}
		var update = { complete: 1 };
		if (err) {
			update.code = err.code || 1;
			update.description = err.message || err;
		}
		else {
			update.code = 0;
			update.description = "Success (HTTP " + resp.statusCode + " " + resp.statusMessage + ")";
		}
		print( "\n" + update.description + "\n" );
		if (resp && resp.rawHeaders) {
			var rows = [];
			print("\nResponse Headers:\n");
			for (var idx = 0, len = resp.rawHeaders.length; idx < len; idx += 2) {
				rows.push([ resp.rawHeaders[idx], resp.rawHeaders[idx + 1] ]);
				print( resp.rawHeaders[idx] + ": " + resp.rawHeaders[idx + 1] + "\n" );
			}
			update.table = {
				title: "HTTP Response Headers",
				header: ["Header Name", "Header Value"],
				rows: rows.sort( function(a, b) {
					return a[0].localeCompare(b[0]);
				} )
			};
		}
		if (job.chain) {
			update.chain_data = { headers: resp.headers };
		}
		if (text && resp.headers['content-type'] && resp.headers['content-type'].match(/(text|javascript|json|css|html)/i)) {
			print("\nRaw Response Content:\n" + text.trim() + "\n");
			if (text.length < 32768) {
				update.html = {
					title: "Raw Response Content",
					content: "<pre>" + text.replace(/</g, '&lt;').trim() + "</pre>"
				};
			}
			if (job.chain && (text.length < 1024 * 1024) && resp.headers['content-type'].match(/(application|text)\/json/i)) {
				var json = null;
				try { json = JSON.parse(text); }
				catch (e) {
					print("\nWARNING: Failed to parse JSON response: " + e + " (could not include JSON in chain_data)\n");
				}
				if (json) update.chain_data.json = json;
			}
		}
		if (perf) {
			update.perf = perf.metrics();
			print("\nPerformance Metrics: " + perf.summarize() + "\n");
		}
		stream.write(update);
	} );
});