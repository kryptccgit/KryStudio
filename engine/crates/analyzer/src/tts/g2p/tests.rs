use super::*;

fn ph(w: &str) -> String {
    word(w).0
}

#[test]
fn dictionary_words_in_kokoro_phonemes() {
    let cases = [
        ("hello", "həlˈO"),
        ("world", "wˈɜɹld"),
        ("water", "wˈɔɾəɹ"),
        ("party", "pˈɑɹɾi"),
        ("button", "bˈʌtən"),
        ("music", "mjˈuzɪk"),
        ("thinking", "θˈɪŋkɪŋ"),
        ("judge", "ʤˈʌʤ"),
        ("church", "ʧˈɜɹʧ"),
        ("voice", "vˈYs"),
        ("night", "nˈIt"),
        ("cat's", "kˈæts"),
    ];
    for (w, want) in cases {
        assert_eq!(ph(w), want, "{w}");
        assert_eq!(word(w).1, Source::Dictionary, "{w}");
    }
}

#[test]
fn function_words_are_weak() {
    assert_eq!(ph("the"), "ðə");
    assert_eq!(ph("of"), "əv");
    assert_eq!(ph("to"), "tə");
    assert_eq!(word("and").1, Source::Function);
    assert!(phonemize("the apple").phonemes.starts_with("ði "));
    assert!(phonemize("the beat").phonemes.starts_with("ðə "));
}

#[test]
fn out_of_dictionary_words() {
    assert_eq!(word("beatmakers"), ("bˈitmˌAkəɹz".to_string(), Source::Derived));
    assert_eq!(word("vibing").1, Source::Derived);
    assert_eq!(ph("vibing"), "vˈIbɪŋ");
    assert_eq!(ph("lovesick"), "lˈʌvsˌɪk");
    assert_eq!(ph("vibin'"), "vˈIbɪn");
    assert_eq!(word("DJ"), ("dˌiʤˈA".to_string(), Source::Spelled));
    assert_eq!(ph("MC"), "ˌɛmsˈi");
    assert_eq!(word("zorblax"), ("zˈɔɹblæks".to_string(), Source::Rules));
    assert_eq!(ph("krypt"), "kɹˈɪpt");
    assert_eq!(ph("skrrt"), "skɹt");
}

#[test]
fn numbers_money_and_abbreviations() {
    let p = phonemize("I paid $5.50 for 3 tracks in 1999.");
    assert_eq!(p.phonemes, "I pˈAd fˈIv dˈɑləɹz fˈɪfti sˈɛnts fɔɹ θɹˈi tɹˈæks ɪn nˈIntˈin nˈInti nˈIn.");
    let texts: Vec<&str> = p.words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, ["I", "paid", "$5.50", "for", "3", "tracks", "in", "1999"]);
    let p = phonemize("It's the 21st century; 50% of us.");
    assert!(p.phonemes.contains("twˈɛnti fˈɜɹst"), "{}", p.phonemes);
    assert!(p.phonemes.contains("fˈɪfti pəɹsˈɛnt"), "{}", p.phonemes);
    assert!(phonemize("Dr. Dre").phonemes.starts_with("dˈɑktəɹ "));
}

#[test]
fn sentences_split_on_punctuation_not_abbreviations() {
    let s = sentences("Hello there. Mr. Smith arrived at 3.5 p.m.! Did he?\nNew line");
    assert_eq!(s, ["Hello there.", "Mr. Smith arrived at 3.5 p.m.!", "Did he?", "New line"]);
}

#[test]
fn punctuation_and_word_spans() {
    let p = phonemize("Hello, \"big\" world (yes)!");
    assert_eq!(p.phonemes, "həlˈO, \"bˈɪɡ\" wˈɜɹld (jˈɛs)!");
    let chars: Vec<char> = p.phonemes.chars().collect();
    for w in &p.words {
        let s: String = chars[w.start..w.end].iter().collect();
        assert_eq!(s, ph(&w.text.to_lowercase()), "{}", w.text);
    }
    let all = phonemize("Zany quixotic jukebox vibes, 1,234 ways — whoa… (FYI) \"quoted\"; colon: done!");
    let (ids, _) = super::super::vocab::encode(&all.phonemes);
    assert_eq!(ids.len(), all.phonemes.chars().count(), "{}", all.phonemes);
}

#[test]
fn split_long_keeps_words() {
    let p = phonemize(&"one two three, four five six. ".repeat(20));
    let pieces = split_long(p.clone(), 60);
    assert!(pieces.len() > 3);
    assert!(pieces.iter().all(|x| x.phonemes.chars().count() <= 60));
    assert_eq!(pieces.iter().map(|x| x.words.len()).sum::<usize>(), p.words.len());
    for piece in &pieces {
        let chars: Vec<char> = piece.phonemes.chars().collect();
        for w in &piece.words {
            assert_eq!(chars[w.start..w.end].iter().collect::<String>(), ph(&w.text));
        }
    }
}

#[test]
fn dictionary_is_complete() {
    ensure_dict().unwrap();
    assert!(dict().unwrap().lines.len() > 120_000);
    assert_eq!(cmu("hello"), Some("HH AH0 L OW1"));
    assert_eq!(cmu("zzzzzzz"), None);
}
