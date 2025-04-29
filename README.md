# OpenAI Transcriber

## 概要  
本リポジトリは、ブラウザ上で音声を録音し、OpenAI Whisper API で文字起こし・要約を行うシングルページアプリです。フロントエンドのみで完結し、GitHub Pages へ配置するだけで HTTPS 配信と iPhone Safari 対応が可能です。

## 前提条件  
ブラウザは getUserMedia API と IndexedDB に対応している必要があります。PC での開発時は Chrome 115 以降、モバイルは iOS 16 以降の Safari を推奨します。

## セットアップ手順  
1. `index.html` を含む一式をルートに配置し、`git add` と `git commit` を実行します。  
2. `git push` 後、リポジトリ設定の *Pages* で **main /root** を選択してください。  
3. 数十秒で `https://<ユーザ名>.github.io/<リポジトリ名>/` が発行されます。  

## 使い方  
ページを開き、最初に設定アイコンから OpenAI API キーを入力・保存します。録音ボタンを押すとマイク許可ダイアログが出るので許可してください。録音停止後、右欄に結果が保存されます。最大十件まで自動で履歴化され、古い記録は順次削除されます。

## 開発メモ  
ローカル確認用に VS Code Live Server などで `http://localhost` 配信すれば HTTPS 要件を満たします。スマホ実機で即時テストしたい場合は Cloudflare Tunnel を併用すると便利です。

## ライセンス  
MIT License です。詳細は `LICENSE` を参照してください。
