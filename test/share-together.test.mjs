import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const list=source.slice(source.indexOf('function movieListText('),source.indexOf('function composeShareMessage('));
const compose=source.slice(source.indexOf('function togetherShareText('),source.indexOf('function appendTogetherShare('));
test('shared joint results include titles, release years and site link',()=>{const text=runInNewContext(list+compose+"togetherShareText([{title:'First',release_date:'2024-10-01'},{title:'Second',release_date:''}],'https://movies.example')");assert.match(text,/First \(2024\)/);assert.match(text,/Second/);assert.match(text,/https:\/\/movies\.example\//)});
