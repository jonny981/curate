# Misses of Curate (full)

The 54 questions that gpt-6.1-sol marked wrong in `answers-6000.jsonl.gz` (Curate's answering prompt), in dataset order, with the answer given and the evidence turns LoCoMo names.
`python3 rebuild.py locomo10.json --misses` prints each one with its question, LoCoMo's answer key and the evidence turns in the conversation's own words, read from your copy of the dataset.

| Question | Category | Answer given | Marked by gpt-4o-mini | Evidence turns |
| --- | --- | --- | --- | --- |
| `conv-26:66` | multi-hop | Melanie explores nature and forests with her family, enjoys mountain views, and spends time relaxing and bonding with them. | wrong | `D16:4`, `D10:12` |
| `conv-26:85` | single-hop | Caroline plans to attend a transgender conference in July to meet others in the community and learn about advocacy. She also plans an LGBTQ art show featuring her paintings, initially planned for August and later moved to September, to promote understanding and acceptance. She and Melanie plan a special summer trip together to catch up, explore nature, and make memories. | wrong | `D2:8` |
| `conv-26:135` | single-hop | Melanie’s son was in a car accident during their family road trip on October 14–15, 2023. It frightened the whole family, but her son was okay. | wrong | `D17:8` |
| `conv-30:34` | temporal | By May 27, 2023, when she announced her acceptance into a part-time fashion internship at an international company. | wrong | `D17:1` |
| `conv-41:8` | open-domain | John is likely experiencing financial difficulty, with existing money troubles and car repair costs compounded by his recent job loss. The potential tech job could improve his finances. | wrong | `D5:5` |
| `conv-41:48` | temporal | Sunday, July 30, 2023. | wrong | `D26:4` |
| `conv-42:4` | open-domain | Stuffed animal pets, like her stuffed dog Tilly, wouldn’t cause Joanna any discomfort. | wrong | `D2:23` |
| `conv-42:12` | open-domain | Joanna might have **atopy—a tendency to develop multiple allergies**. She also has **lactose intolerance**, which is separate from an allergy. | wrong | `D5:11`, `D2:23` |
| `conv-42:52` | multi-hop | Three of Joanna’s writing projects have made it to the big screen. | wrong | `D15:1`, `D25:2` |
| `conv-42:53` | multi-hop | Four times.** | wrong | `D5:4`, `D25:15` |
| `conv-42:62` | multi-hop | 3 letters. | wrong | `D14:1`, `D18:5` |
| `conv-42:66` | open-domain | Nate might become a YouTube gaming content creator. | wrong | `D5:8`, `D19:3`, `D25:19`, `D28:25` |
| `conv-42:78` | multi-hop | **12 video game tournaments.** | wrong | `D1:3`, `D6:7`, `D10:4`, `D14:8`, `D17:1`, `D19:1`, `D20:1`, `D22:2`, `D27:1` |
| `conv-42:79` | multi-hop | Five screenplays, including the two she was still working on. | wrong | `D2:3`, `D4:10`, `D5:1`, `D12:13`, `D12:14` |
| `conv-42:91` | single-hop | Nate’s favorite book series is a space opera with awesome battles, action scenes, interesting characters, and an exciting plot. | wrong | `D9:14` |
| `conv-42:195` | single-hop | Nate wants to bake and cook with Joanna and try her chocolate and raspberry cake. | wrong | `D28:29` |
| `conv-43:6` | temporal | July 2023, when he scored 40 points. | wrong | `D3:1` |
| `conv-43:50` | multi-hop | **“Dune” by Frank Herbert**, which John described as a story about religion and human control over ecology. | wrong | `D19:20`, `D18:2` |
| `conv-43:51` | open-domain | John might benefit from practicing Warrior II, which works his legs and core and builds strength, balance, and stability. He typically holds it for 30–60 seconds. | wrong | `D20:2` |
| `conv-43:55` | temporal | John started playing professionally around early 2023, after being drafted following college. | right | `D1:3`, `D21:4` |
| `conv-43:66` | open-domain | A Star Wars adventure novel with rich world-building and compelling characters. | wrong | `D27:19`, `D27:21` |
| `conv-43:67` | open-domain | Travel photography would be a good hobby for Tim, especially capturing castles, Galway’s arts scene, and landscapes such as the Cliffs of Moher. | wrong | `D4:1`, `D6:6`, `D15:3`, `D27:37` |
| `conv-43:86` | single-hop | John said he’d played an intense game the previous week, his team won by a narrow score, and he scored the final basket while the crowd cheered. | wrong | `D5:1` |
| `conv-43:135` | single-hop | Tim breaks his studying into smaller chunks: 25 minutes of studying followed by a 5-minute break for something fun. This makes studying feel less overwhelming and helps him stay on track. | wrong | `D18:6` |
| `conv-43:164` | single-hop | French, which he studied in high school. | wrong | `D27:6` |
| `conv-43:166` | single-hop | *The Lord of the Rings* by J. R. R. Tolkien. | wrong | `D27:19` |
| `conv-44:16` | temporal | Saturday, November 4, 2023. | wrong | `D11:7` |
| `conv-44:17` | multi-hop | **2 times.** | wrong | `D11:7`, `D24:13`, `D26:20` |
| `conv-44:19` | open-domain | Playing dog-friendly puzzle games indoors would entertain Andrew while keeping his dog mentally stimulated and happy. | wrong | `D10:12`, `D12:1` |
| `conv-44:43` | open-domain | Colorado. | wrong | `D11:9` |
| `conv-44:44` | open-domain | A mountainous, dog-friendly national park with hiking trails and scenic sunset views from a peak. | wrong | `D5:8`, `D11:9` |
| `conv-44:52` | open-domain | Andrew could take short birdwatching breaks in nearby city parks, fitting them around work. He already visits parks when he can and could bring his binoculars and notebook to spot birds and record what he sees without needing a full hiking trip. | right | `D20:5`, `D20:21`, `D23:1`, `D1:14` |
| `conv-44:57` | temporal | Andrew adopted Scout shortly before November 22, 2023. | right | `D28:6` |
| `conv-47:11` | temporal | John was feeling busy and stressed by work and everyday life, with little time for gaming to help him unwind. | wrong | `D6:7` |
| `conv-47:17` | open-domain | Among Us. | wrong | `D8:36` |
| `conv-47:31` | temporal | 9 days, from July 11 to July 20, 2022. | wrong | `D16:9`, `D16:13` |
| `conv-48:101` | single-hop | Jolene bought Seraphim in January 2022 in Paris. | right | `D2:24` |
| `conv-48:115` | single-hop | Deborah incorporates a morning jog in a nearby park into her daily routine. | wrong | `D7:18` |
| `conv-48:179` | single-hop | Jolene played “Detroit” on the console with her partner the week before January 27, 2023. She said it was fun and they were both crazy about gaming. | wrong | `D27:12` |
| `conv-49:11` | multi-hop | Sam had gastritis, which caused a severe stomachache and sent him to the ER. The scare motivated him to prioritize his health through a more nutritious diet and regular exercise. | wrong | `D2:6`, `D3:4`, `D24:12`, `D24:14`, `D5:5`, `D6:2`, `D7:2`, `D7:12`, `D8:1`, `D10:6`, `D12:1`, `D13:2`, `D14:1`, `D15:1`, `D16:3`, `D17:3`, `D24:20`, `D25:1`, `D25:3` |
| `conv-49:24` | temporal | Towards the end of summer 2023, a health scare prompted Sam to take better care of himself through healthier cooking, a new diet, and regular exercise. | wrong | `D5:1` |
| `conv-49:64` | multi-hop | Sam faces obesity, with related discomfort and reduced mobility. | wrong | `D2:6`, `D7:2`, `D12:1`, `D14:1` |
| `conv-49:80` | temporal | January 9, 2024. | wrong | `D24:3` |
| `conv-49:106` | single-hop | Evan started watercolor painting after a friend gave him a painting that inspired him. | right | `D8:14` |
| `conv-49:116` | single-hop | Evan shared a painting of a peaceful sunset, showing a person on a cliff. | wrong | `D11:8` |
| `conv-49:144` | single-hop | Evan shared a photo from his family’s trip to the Canadian Rockies, showing a lake with rocks and mountains in the background. | wrong | `D22:1` |
| `conv-50:7` | open-domain | No, Dave’s shop has a small team of mechanics rather than a lot of employees. | wrong | `D4:17` |
| `conv-50:27` | temporal | Tokyo, Japan. | wrong | `D16:6` |
| `conv-50:47` | multi-hop | 4 car shows. | wrong | `D3:12`, `D22:1` |
| `conv-50:109` | single-hop | Calvin is excited about visiting Tokyo in November 2023, exploring Shibuya Crossing and Shinjuku, enjoying the food again, and trying ramen for the first time. | wrong | `D18:7` |
| `conv-50:137` | single-hop | Calvin was interested in cars by March 2023, when he had bought a Ferrari 488 GTB and taken it for a drive on March 25. | wrong | `D26:6` |
| `conv-50:141` | single-hop | Tokyo, Japan. | wrong | `D27:6` |
| `conv-50:147` | single-hop | Calvin boosts his motivation through: - Positive fan feedback, seeing his music connect with people, and knowing it makes a difference. - Performing live and feeling the crowd’s energy and connection. - Collaborating with artists, learning from industry professionals, and exchanging creative ideas. - Supportive friends and people who encourage him, bring positive energy, and help him stay true to himself. - Remembering his passion, dreams, original reasons for making music, and the progress he has made. - Setting goals to reach a global audience, grow his fanbase, and make an impact. - Experimenting with new sounds while keeping his own musical identity. - Staying informed about world events and drawing inspiration from people’s struggles and feelings. - Taking breaks, enjoying favorite activities, and relaxing to recharge. - Watching music videos, concerts, and documentaries about artists and their creative processes. - Supporting young musicians, whose enthusiasm and fresh ideas inspire him. - Seeing Dave pursue engineering and work on cars, which encourages Calvin to keep pushing his music. | wrong | `D28:34` |
| `conv-50:151` | single-hop | Calvin took up restoring vintage cars, which helps him relax and gives him a sense of achievement. | wrong | `D30:1` |
