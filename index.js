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
            datetime TEXT,
            reminded INTEGER DEFAULT 0
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
    loadInterviews();
});



// リマインダーを送る関数


async function sendReminder() {
    try {
        const now = DateTime.now().setZone('Asia/Tokyo');

        // 現在時刻以降の面接で、リマインダー未送信のものを取得
        const rows = await dbAll('SELECT * FROM interviews WHERE reminded = 0 AND datetime >= ?', [now.toISO()]);

        console.log('取得した面接情報:', rows);

        for (const row of rows) {
            // `datetime` を ISO 8601 形式としてパース
            const interviewTime = DateTime.fromISO(row.datetime, { zone: 'Asia/Tokyo' });

            console.log(`面接日時: ${interviewTime.toFormat('yyyy-MM-dd HH:mm')}`);

            // 10分前～開始時刻の範囲ならリマインダー送信
            if (interviewTime.minus({ minutes: 10 }) <= now && interviewTime > now) {
                console.log(`リマインダー送信条件を満たしました: ユーザーID: ${row.user_id}, 面接日時: ${interviewTime.toFormat('yyyy-MM-dd HH:mm')}`);

                try {
                    const user = await bot.users.fetch(row.user_id);

                    if (user) {
                        console.log(`リマインダー送信中: ユーザー名: ${user.username}`);

                        // メッセージフォーマット
                        const message = `
                        __⏰ **説明会のリマインダーです！**__\n**サーバー名:** いい声界隈\n**日時:** ${interviewTime.toFormat('yyyy/MM/dd HH:mm')}\n\nこの説明会は、もうすぐ実施されます。お忘れなく！
                        `;
                        await user.send(message);

                        // 面接結果チャンネルにも通知
                        try {
                            const resultChannel = await bot.channels.fetch(INTERVIEW_RESULT_CHANNEL_ID);
                            if (resultChannel) {
                                const embed = new EmbedBuilder()
                                    .setColor('#FF5733')
                                    .setDescription(`**希望者:** <@${row.user_id}> さん\n**面接日時:** ${interviewTime.toFormat('yyyy/MM/dd HH:mm')}`)
                                    .setThumbnail(user.displayAvatarURL())
                                    .setFooter({ text: '準備をお願いします！' })
                                    .setTimestamp();

                                await resultChannel.send({
                                    content: '**⏰ 面接リマインダー**',
                                    embeds: [embed]
                                });
                            }
                        } catch (channelError) {
                            console.error('リマインダーチャンネルの取得に失敗:', channelError);
                        }

                        // reminded フラグを更新
                        db.run('UPDATE interviews SET reminded = 1 WHERE id = ?', [row.id], (err) => {
                            if (err) {
                                console.error('リマインダーの更新に失敗しました:', err);
                            } else {
                                console.log(`リマインダー送信後に更新完了: 面接ID: ${row.id}`);
                            }
                        });
                    } else {
                        console.log(`ユーザーが見つかりませんでした: ${row.user_id}`);
                    }
                } catch (userFetchError) {
                    console.error(`ユーザー情報の取得に失敗: ${row.user_id}`, userFetchError);
                }
            } else {
                console.log(`リマインダー送信条件未満: ユーザーID: ${row.user_id}, 面接日時: ${interviewTime.toFormat('yyyy-MM-dd HH:mm')}`);
            }
        }
    } catch (err) {
        console.error('面接情報の取得に失敗しました:', err);
    }
}

// 1分ごとにリマインダーをチェック
setInterval(() => {
    console.log('リマインダー確認中...');
    sendReminder();
}, 60 * 1000); // 1分ごとにリマインダーを送る



function containsDateOrTime(content) {
    const dateOrTimeRegex = /([０-９\d]{1,2}時|[０-９\d]{1,2}じ|今日|明日|いつでも|何時でも|なんじでも|今から|いまから)/;
    return dateOrTimeRegex.test(content);
}

const messageTrack = new Map();
let interviewList = [];  // 面接情報をIDなしで管理する配列




// 面接情報をリセットし、新しいIDを振り直す
function resetInterviewIds() {
    db.all("SELECT rowid, * FROM interviews ORDER BY datetime ASC", (err, rows) => {
        if (err) {
            console.error("IDリセットエラー:", err.message);
            return;
        }

        // 面接リストを更新
        const interviewList = rows.map((row, index) => ({
            id: index + 1, // 新しいIDは1から順番に設定
            user: { id: row.user_id },
            time: DateTime.fromISO(row.datetime, { zone: 'UTC' }).setZone('Asia/Tokyo')
        }));

        // DB の id を更新
        let completedUpdates = 0;
        rows.forEach((row, index) => {
            db.run("UPDATE interviews SET id = ? WHERE rowid = ?", [index + 1, row.rowid], function (err) {
                if (err) {
                    console.error(`ID 更新エラー (rowid: ${row.rowid}):`, err.message);
                } else {
                    completedUpdates++;
                    // すべての更新が完了したらログ出力
                    if (completedUpdates === rows.length) {
                        console.log("✅ ID をリセットしました。");
                        // 必要であれば、面接リストをコンソールに表示したり、次の処理を行うことができます。
                    }
                }
            });
        });
    });
}





// 面接情報の読み込みとID振り直し
function loadInterviews() {
    const now = DateTime.now().setZone('Asia/Tokyo').toISO();

    db.run("DELETE FROM interviews WHERE datetime < ?", [now], (err) => {
        if (err) {
            console.error("過去の面接データの削除に失敗:", err);
            return;
        }

        console.log("過去の面接データを削除しました。");

        // IDの再割り当てを行う
        reassignInterviewIds().then(() => {
            console.log("面接IDの再割り当てが完了しました。");
        }).catch((err) => {
            console.error("面接IDの再割り当てに失敗:", err);
        });
    });
}


function reassignInterviewIds(callback) {
    db.all("SELECT rowid, * FROM interviews WHERE datetime >= ? ORDER BY datetime ASC", 
        [DateTime.now().toUTC().toISO()], 
        (err, rows) => {
            if (err) {
                console.error('面接情報の取得に失敗しました:', err);
                return;
            }

            let completedUpdates = 0;
            const totalUpdates = rows.length;

            // ID を振り直し
            rows.forEach((row, index) => {
                db.run("UPDATE interviews SET id = ? WHERE rowid = ?", 
                    [index + 1, row.rowid],  // `user_id`ではなく`rowid`を使用
                    (err) => {
                        if (err) {
                            console.error(`ID の更新に失敗しました (rowid: ${row.rowid})`, err);
                        } else {
                            completedUpdates++;
                            // すべての更新が完了したら
                            if (completedUpdates === totalUpdates) {
                                console.log('面接 ID の振り直しが完了しました');
                                callback();  // コールバックを呼び出す
                            }
                        }
                    }
                );
            });
        }
    );
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



bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    if (!interaction.guild) { // DMの場合、guildがundefinedになることがある
        return interaction.reply({ content: '❌ このコマンドはDMでは使用できません。サーバー内で試してください。', flags: 64 });
    }

    if (interaction.commandName === 'register_interview') {
        const user = interaction.options.getUser('user');
        const datetime = interaction.options.getString('datetime');

        // 入力フォーマットの厳密チェック (MM-DD HH:mm)
        const datetimeRegex = /^\d{2}-\d{2} \d{2}:\d{2}$/;
        if (!datetimeRegex.test(datetime)) {
            return interaction.reply({ content: '❌ 無効な日時フォーマットです。例: `02-10 15:00`', flags: 64 });
        }

        // 現在の年を取得（日本時間）
        const currentYear = DateTime.now().setZone('Asia/Tokyo').year;

        // 入力された日時に現在の年を付与
        let formattedDatetime = `${currentYear}-${datetime}`;

        // JST でパース
        let interviewTime = DateTime.fromFormat(formattedDatetime, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Tokyo' });

        // 過去の日時なら翌年に補正
        if (interviewTime < DateTime.now().setZone('Asia/Tokyo')) {
            interviewTime = interviewTime.plus({ years: 1 });
        }

        // DB に保存する際は UTC に変換
        const interviewTimeUTC = interviewTime.toUTC().toISO();

        // データベースに保存
        db.run("INSERT INTO interviews (user_id, datetime) VALUES (?, ?)", 
            [user.id, interviewTimeUTC], 
            function(err) {
                if (err) {
                    console.error(err.message);
                    return interaction.reply({ content: '❌ 面接の登録に失敗しました。', flags: 64 });
                }

                // 面接 ID の振り直しを DB 操作後に行う（コールバックベースに修正）
                reassignInterviewIds(() => {
                    // JST に変換してユーザーに表示
                    const formattedReplyTime = DateTime.fromISO(interviewTimeUTC, { zone: 'UTC' }).setZone('Asia/Tokyo');
                    interaction.reply(`✅ <@${user.id}> さんの面接を ${formattedReplyTime.toFormat('yyyy-MM-dd HH:mm')} に登録しました。`);
                });
            }
        );
    }



    if (interaction.commandName === 'list_interviews') {
        interaction.deferReply({ flags: 64 }); // 応答を保留

        // 現在の UTC 時間を取得
        const nowUTC = DateTime.now().toUTC().toISO();

        // 過去の面接を削除 (UTC ベースで比較)
        db.run("DELETE FROM interviews WHERE datetime < ?", [nowUTC], function (err) {
            if (err) {
                console.error("削除エラー:", err.message);
                return interaction.editReply({ content: '❌ 面接データの整理に失敗しました。' });
            }

            console.log(`削除された面接数: ${this.changes}`);

            // 削除後、再度面接リストを取得
            db.all("SELECT id, user_id, datetime FROM interviews WHERE datetime >= ? ORDER BY datetime ASC", [nowUTC], (err, rows) => {
                if (err) {
                    console.error("取得エラー:", err.message);
                    return interaction.editReply({ content: '❌ 面接リストの取得に失敗しました。' });
                }

                if (rows.length === 0) {
                    return interaction.editReply({ content: '❌ 現在登録されている面接はありません。' });
                }

                // 面接リストの埋め込みメッセージ作成
                const resultMessageContent = `__**登録されている面接日程**__`;
                const embed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTimestamp()
                    .setFooter({ text: '面接の詳細をご確認ください' });

                rows.forEach((row, index) => {
                    const time = DateTime.fromISO(row.datetime, { zone: 'UTC' }).setZone('Asia/Tokyo'); // UTC から JST に変換
                    embed.addFields({
                        name: `ID: ${index + 1}`, // IDを1から順番に表示
                        value: `- <@${row.user_id}>\n📅 ${time.toFormat('yyyy-MM-dd HH:mm')}`,
                        inline: false,
                    });
                });

                bot.channels.fetch(INTERVIEW_RESULT_CHANNEL_ID, (error, resultChannel) => {
                    if (error) {
                        console.error("チャンネル送信エラー:", error);
                        return interaction.editReply({ content: '❌ 面接リストの送信に失敗しました。' });
                    }

                    resultChannel.send({ content: resultMessageContent, embeds: [embed] }, (err) => {
                        if (err) {
                            console.error("チャンネル送信エラー:", err);
                            return interaction.editReply({ content: '❌ 面接リストの送信に失敗しました。' });
                        }

                        interaction.editReply({ content: '✅ 面接リストを更新しました。' });
                    });
                });
            });
        });
    }





    if (interaction.commandName === 'delete_interview') {
        const id = interaction.options.getInteger('id'); // リストに表示されたID番号を取得

        // IDに基づいて削除対象の面接を取得
        db.all("SELECT rowid, * FROM interviews ORDER BY datetime ASC", (err, rows) => {
            if (err) {
                console.error("面接情報の取得に失敗しました:", err.message);
                return interaction.reply({ content: "❌ 面接情報の取得に失敗しました。", flags: 64 });
            }

            // 指定されたIDに対応する行を探す
            const targetRow = rows.find((_, index) => index + 1 === id);  // row ではなく index を使う

            if (!targetRow) {
                return interaction.reply({ content: `⚠️ 面接ID ${id} は存在しません。`, flags: 64 });
            }

            console.log(`削除対象行:`, targetRow); // 確認用のログ

            // 対象の面接を削除
            db.run("DELETE FROM interviews WHERE rowid = ?", [targetRow.rowid], function (err) {
                if (err) {
                    console.error("削除エラー:", err.message);
                    return interaction.reply({ content: "❌ 面接の削除に失敗しました。", flags: 64 });
                }

                interaction.reply({ content: `✅ 面接ID ${id} を削除しました。`, flags: 64 });

                // 削除後にIDを振り直す
                resetInterviewIds();
            });
        });
    }


});


bot.login(process.env.DISCORD_TOKEN);
