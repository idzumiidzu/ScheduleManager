const { Client: Bot, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const dotenv = require('dotenv');
const { DateTime } = require('luxon');
const sqlite3 = require('sqlite3').verbose();

dotenv.config();

const bot = new Bot({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const INTERVIEW_REQUEST_CHANNEL_ID = process.env.INTERVIEW_REQUEST_CHANNEL_ID;
const INTERVIEW_MANAGE_CHANNEL_ID = process.env.INTERVIEW_MANAGE_CHANNEL_ID;
const INTERVIEW_RESULT_CHANNEL_ID = process.env.INTERVIEW_RESULT_CHANNEL_ID;
const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID;

const db = new sqlite3.Database('./interviews.db', (err) => {
    if (err) {
        console.error('データベースの接続に失敗しました:', err);
    } else {
        console.log('データベースに接続しました');
        db.run(`CREATE TABLE IF NOT EXISTS interviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            datetime TEXT
        )`);
    }
});

bot.once('ready', async () => {
    console.log(`Logged in as ${bot.user.tag}`);

    // コマンドリストを定義
    const commands = [
        new SlashCommandBuilder()
            .setName('register_interview')
            .setDescription('面接の開始時間を登録')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('面接対象者')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option.setName('datetime')
                    .setDescription('面接日時 (例: 02-10 15:00)')
                    .setRequired(true)
            ),

        new SlashCommandBuilder()
            .setName('list_interviews')
            .setDescription('登録されている面接日程を表示'),

        new SlashCommandBuilder()
            .setName('delete_interview')
            .setDescription('面接をIDで削除')
            .addIntegerOption(option =>
                option.setName('id')
                    .setDescription('削除する面接のID')
                    .setRequired(true)
            )
    ];

    // コマンドを登録
    await bot.application.commands.set(commands);
    console.log("コマンドが正常に登録されました");
    startReminderScheduler();
    loadInterviews();
});

function containsDateOrTime(content) {
    const dateOrTimeRegex = /([０-９\d]{1,2}時|[０-９\d]{1,2}じ|今日|明日|いつでも|何時でも|なんじでも|今から|いまから)/;
    return dateOrTimeRegex.test(content);
}

const messageTrack = new Map();
let interviewList = [];  // 面接情報をIDなしで管理する配列




function loadInterviews() {
    db.all("SELECT * FROM interviews", [], (err, rows) => {
        if (err) {
            throw err;
        }
        interviewList = rows.map(row => ({
            id: row.id,
            user: bot.users.cache.get(row.user_id),
            time: DateTime.fromISO(row.datetime)
        }));
        console.log('面接情報がデータベースから読み込まれました');
    });
}

bot.on('messageCreate', async (message) => {
    if (message.channel.id === INTERVIEW_REQUEST_CHANNEL_ID && !message.author.bot) {
        const member = await message.guild.members.fetch(message.author.id);
        if (!member.roles.cache.has(REQUIRED_ROLE_ID)) return;
        if (!containsDateOrTime(message.content)) return;

        const manageChannel = await bot.channels.fetch(INTERVIEW_MANAGE_CHANNEL_ID);
        const forwardedMessage = await manageChannel.send({
            content: `📝 **新規面接希望**`,
            embeds: [
                new EmbedBuilder()
                    .setColor('#00FF00') // 緑色
                    .setDescription(`**申請者**: ${message.author}\n**希望日時**: ${message.content}`)
                    .setThumbnail(message.author.avatarURL()) // 申請者のプロフィール画像をサムネイルに設定
                    .setTimestamp()
                    .setFooter({ text: '✅:対応可能, ❌:対応不可' })
            ]
        });

        await forwardedMessage.react('✅'); // 承認
        await forwardedMessage.react('❌'); // 不承認
        message.react('📩'); // 面接希望の通知反応

        // メッセージとその他情報を保存
        messageTrack.set(forwardedMessage.id, { author: message.author, content: message.content });
    }
});


// リアクション追加時の処理
bot.on('messageReactionAdd', async (reaction, user) => {
    if (reaction.message.channel.id !== INTERVIEW_MANAGE_CHANNEL_ID || user.bot) return;
    const message = reaction.message;
    const trackedMessage = messageTrack.get(message.id);
    if (!trackedMessage) return;

    // すでにどちらかが押されていたら、もう片方を削除
    if (reaction.emoji.name === '✅') {
        // ❌ が押されていた場合は削除
        const rejectReaction = message.reactions.cache.get('❌');
        if (rejectReaction) {
            await rejectReaction.users.remove(user);
        }
    } else if (reaction.emoji.name === '❌') {
        // ✅ が押されていた場合は削除
        const approveReaction = message.reactions.cache.get('✅');
        if (approveReaction) {
            await approveReaction.users.remove(user);
        }
    }

    updateReactionCount(message);
});

bot.on('messageReactionRemove', async (reaction, user) => {
    if (reaction.message.channel.id !== INTERVIEW_MANAGE_CHANNEL_ID || user.bot) return;
    const message = reaction.message;
    updateReactionCount(message);
});

async function updateReactionCount(message) {
    const trackedMessage = messageTrack.get(message.id);
    if (!trackedMessage) return;

    const approveUsers = [];
    const rejectUsers = [];
    const approveReaction = message.reactions.cache.get('✅');
    const rejectReaction = message.reactions.cache.get('❌');

    if (approveReaction) {
        const users = await approveReaction.users.fetch();
        users.forEach(u => { if (!u.bot) approveUsers.push(`<@${u.id}>`); });
    }
    if (rejectReaction) {
        const users = await rejectReaction.users.fetch();
        users.forEach(u => { if (!u.bot) rejectUsers.push(`<@${u.id}>`); });
    }

    const resultChannel = await bot.channels.fetch(INTERVIEW_RESULT_CHANNEL_ID);

    // メッセージの本文に「面接リアクション集計」を出す
    const resultMessageContent = `📊 **面接リアクション集計**`;

    // Embedを作成
    const embed = new EmbedBuilder()
        .setColor('#00FF00') // 緑色に設定
        .setDescription(`**申請者**: <@${trackedMessage.author.id}>\n**希望日時**: ${trackedMessage.content}`)
        .addFields(
            {
                name: '✅ **対応可能**',
                value: approveUsers.length > 0 ? approveUsers.map(user => `- ${user}`).join('\n') : 'なし',  // ユーザー名の前に `-` を追加
                inline: true
            },
            {
                name: '❌ **対応不可**',
                value: rejectUsers.length > 0 ? rejectUsers.map(user => `- ${user}`).join('\n') : 'なし', // ユーザー名の前に `-` を追加
                inline: true
            }
        )
        .setTimestamp()
        .setFooter({ text: '面接の詳細をご確認ください' });

    // 集計結果メッセージを更新
    if (messageTrack.has(message.id)) {
        const existingResultMessage = messageTrack.get(message.id).resultMessage;
        if (existingResultMessage) {
            await existingResultMessage.edit({ content: resultMessageContent, embeds: [embed] });
        } else {
            const newResultMessage = await resultChannel.send({ content: resultMessageContent, embeds: [embed] });
            messageTrack.set(message.id, { ...trackedMessage, resultMessage: newResultMessage });
        }
    }
}




bot.on('interactionCreate', async (interaction) => {  // interactionCreate イベントを非同期関数として定義
    if (!interaction.isCommand()) return;

    if (interaction.channel.type === 'DM') {
        return interaction.reply({ content: '❌ このコマンドはDMでは使用できません。サーバー内で試してください。', flags: 64 });
    }

    if (interaction.commandName === 'register_interview') {
        const user = interaction.options.getUser('user');
        const datetime = interaction.options.getString('datetime');

        // 現在の年を取得
        const currentYear = DateTime.now().setZone('Asia/Tokyo').year;

        // 入力された日時に現在の年を付与
        let formattedDatetime = `${currentYear}-${datetime}`;

        // Luxon を使って JST でパース
        let interviewTime = DateTime.fromFormat(formattedDatetime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });

        // 過去の日時なら翌年に補正
        if (interviewTime < DateTime.now().setZone('Asia/Tokyo')) {
            interviewTime = interviewTime.plus({ years: 1 });
            formattedDatetime = `${interviewTime.year}-${datetime}`;
        }

        // 最終的な JST 変換
        interviewTime = DateTime.fromFormat(formattedDatetime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });

        // 無効な日時ならエラー
        if (!interviewTime.isValid) {
            return interaction.reply({ content: '❌ 無効な日時フォーマットです。例: 02-10 15:00', flags: 64 });
        }

        // データベースに JST 形式で保存
        db.run("INSERT INTO interviews (user_id, datetime) VALUES (?, ?)", 
            [user.id, interviewTime.toFormat('yyyy-MM-dd HH:mm')], // JST のまま保存
            function(err) {
                if (err) {
                    console.error(err.message);
                    return interaction.reply({ content: '❌ 面接の登録に失敗しました。', flags: 64 });
                }

                // 面接リストに追加し、JST のままソート
                interviewList.push({ id: this.lastID, user: user, time: interviewTime });
                interviewList.sort((a, b) => a.time.toMillis() - b.time.toMillis());

                // ID を振り直し
                interviewList.forEach((info, index) => {
                    info.id = index + 1;
                });

                // 確認メッセージ
                interaction.reply(`✅ <@${user.id}> さんの面接を ${interviewTime.toFormat('yyyy-MM-dd HH:mm')} に登録しました。`);
            }
        );
    }


    if (interaction.commandName === 'list_interviews') {
        await interaction.deferReply({ flags: 64 }); // 応答を保留

        const now = DateTime.now().setZone('Asia/Tokyo').toFormat('yyyy-MM-dd HH:mm'); // JST のまま比較


        // 過去の面接を削除
        db.run("DELETE FROM interviews WHERE datetime < ?", [now], function (err) {
            if (err) {
                console.error("削除エラー:", err.message);
                return interaction.editReply({ content: '❌ 面接データの整理に失敗しました。' });
            }

            console.log(`削除された面接数: ${this.changes}`);

            // 最新の面接リストを取得
            db.all("SELECT id, user_id, datetime FROM interviews WHERE datetime >= ? ORDER BY datetime ASC", [now], async (err, rows) => {
                if (err) {
                    console.error("取得エラー:", err.message);
                    return interaction.editReply({ content: '❌ 面接リストの取得に失敗しました。' });
                }

                if (rows.length === 0) {
                    return interaction.editReply({ content: '❌ 現在登録されている面接はありません。' });
                }

                // データベースのデータを面接リストに変換し、時間でソート
                interviewList = rows.map((row, index) => ({
                    id: index + 1, // ID を 1 から振り直し
                    user: { id: row.user_id },
                    time: DateTime.fromFormat(row.datetime, 'yyyy-MM-dd HH:mm') // JST でそのままパース
                })).sort((a, b) => a.time - b.time); // 時間でソート

                const resultMessageContent = `__**登録されている面接日程**__`;
                const embed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTimestamp()
                    .setFooter({ text: '面接の詳細をご確認ください' });

                interviewList.forEach((info) => {
                    embed.addFields({
                        name: `ID: ${info.id}`,
                        value: `- <@${info.user.id}>\n📅 ${info.time.toFormat('yyyy-MM-dd HH:mm')}`,
                        inline: false,
                    });
                });

                const resultChannel = await bot.channels.fetch(INTERVIEW_RESULT_CHANNEL_ID);
                await resultChannel.send({ content: resultMessageContent, embeds: [embed] });
            });
        });
    }



    if (interaction.commandName === 'delete_interview') {
        await interaction.deferReply({ flags: 64 }); // まず応答を保留

        const interviewId = interaction.options.getInteger('id'); // 数値として取得

        if (!interviewId) {
            return interaction.editReply({ content: '❌ 無効なIDです。正しいIDを入力してください。' });
        }

        console.log("指定されたID:", interviewId);

        // デバッグ: 現在の面接データを表示
        db.all("SELECT * FROM interviews", [], (err, rows) => {
            console.log("現在のデータ:", rows);
        });

        // DBから指定IDの面接を検索
        db.get("SELECT * FROM interviews WHERE id = ?", [interviewId], async (err, row) => {
            if (err) {
                console.error("データベース取得エラー:", err.message);
                return interaction.editReply({ content: '❌ 面接データの取得に失敗しました。' });
            }

            if (!row) {
                return interaction.editReply({ content: '❌ 指定された面接が見つかりません。正しいIDを入力してください。' });
            }

            console.log("削除対象:", row);

            // 面接データの削除処理
            db.run("DELETE FROM interviews WHERE id = ?", [interviewId], async function(err) {
                if (err) {
                    console.error("削除エラー:", err.message);
                    return interaction.editReply({ content: '❌ 面接の削除に失敗しました。' });
                }

                // 成功メッセージを送信
                await interaction.editReply(`✅ 面接 ID: ${interviewId} を削除しました。\n対象: <@${row.user_id}> さん\n日時: ${row.datetime}`);
            });
        });
    }


});


function startReminderScheduler() {
    setInterval(async () => {
        const now = DateTime.now().setZone('Asia/Tokyo').toMillis(); // 日本時間に固定
        for (const info of interviewList) {
            if (info.time.toMillis() - now <= 10 * 60 * 1000 && !info.reminded) {
                const resultChannel = await bot.channels.fetch(INTERVIEW_RESULT_CHANNEL_ID);
                await resultChannel.send(`⏰ **リマインダー**: <@${info.user.id}> さんの面接が10分後に予定されています！`);
                info.reminded = true; // 通知済みフラグをセット
            }
        }
    }, 60 * 1000);
}



bot.login(process.env.DISCORD_TOKEN);
