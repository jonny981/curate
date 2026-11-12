# Misses of the 6,000-token setting

The 59 questions that gpt-6.1-sol marked wrong in `answers-6000.jsonl.gz`, in dataset order, with the answer given and the evidence turns LoCoMo names.
`python3 rebuild.py locomo10.json --misses` prints each one with its question, LoCoMo's answer key and the evidence turns in the conversation's own words, read from your copy of the dataset.

| Question | Category | Answer given | Marked by gpt-4o-mini | Evidence turns |
| --- | --- | --- | --- | --- |
| `conv-26:33` | temporal | Caroline went to a pride parade on Friday, August 11, 2023. | wrong | `D5:1` |
| `conv-26:66` | multi-hop | Melanie explores nature and forests with her family, enjoys mountain views, admires flowers, and bonds with them while appreciating the outdoors. | wrong | `D16:4`, `D10:12` |
| `conv-26:85` | single-hop | Caroline plans to attend a transgender conference to meet others and learn about advocacy, hold an LGBTQ art show featuring her paintings, and take a special summer outing with Melanie to catch up and explore nature. | wrong | `D2:8` |
| `conv-30:34` | temporal | By May 27, 2023, when she announced her acceptance into a part-time fashion internship at an international company. | wrong | `D17:1` |
| `conv-30:43` | single-hop | The dancers represent passion, determination, and perseverance in pursuing dreams despite challenges. | wrong | `D1:25` |
| `conv-30:56` | single-hop | They compared their entrepreneurial journeys to a rollercoaster ride, full of ups and downs. | wrong | `D6:15`, `D6:16` |
| `conv-41:8` | open-domain | John appears financially strained, having mentioned money problems, costly car repairs, and recently losing his job when his mechanical engineering company went under. He is seeking a new role at a tech company. | wrong | `D5:5` |
| `conv-41:48` | temporal | John had his first firefighter call-out on Sunday, July 30, 2023. | wrong | `D26:4` |
| `conv-41:85` | single-hop | John volunteered at a neighborhood 5K charity run to raise funds for veterans and their families. | wrong | `D10:13` |
| `conv-42:4` | open-domain | Stuffed animals, like her stuffed dog Tilly, wouldn’t cause Joanna any discomfort from her allergies. | wrong | `D2:23` |
| `conv-42:12` | open-domain | Joanna might have atopy, a predisposition to allergic reactions, given her allergies to furry animals, reptiles, and cockroaches. | wrong | `D5:11`, `D2:23` |
| `conv-42:52` | multi-hop | Three of Joanna’s scripts have made it to the big screen. | wrong | `D15:1`, `D25:2` |
| `conv-42:53` | multi-hop | 4 times. | wrong | `D5:4`, `D25:15` |
| `conv-42:62` | multi-hop | 3 letters. | wrong | `D14:1`, `D18:5` |
| `conv-42:66` | open-domain | Nate might become a YouTube gaming content creator, entertaining viewers and connecting with fellow gamers. | wrong | `D5:8`, `D19:3`, `D25:19`, `D28:25` |
| `conv-42:78` | multi-hop | 11 video game tournaments. | wrong | `D1:3`, `D6:7`, `D10:4`, `D14:8`, `D17:1`, `D19:1`, `D20:1`, `D22:2`, `D27:1` |
| `conv-42:91` | single-hop | Nate’s favorite book series is a space opera featuring exciting battles, action-packed scenes, and interesting characters. | wrong | `D9:14` |
| `conv-42:92` | single-hop | Nate’s gaming room has the glow from his computer monitors. | wrong | `D10:2` |
| `conv-42:195` | single-hop | Nate wants to join Joanna in the kitchen to bake and cook together. | wrong | `D28:29` |
| `conv-43:6` | temporal | July 2023. | wrong | `D3:1` |
| `conv-43:17` | multi-hop | 8 games. | wrong | `D3:3`, `D5:2`, `D22:4`, `D23:7`, `D24:2` |
| `conv-43:51` | open-domain | John might benefit from Warrior II, which works his core and legs. Holding it for 30–60 seconds helps build strength and stability. | wrong | `D20:2` |
| `conv-43:53` | open-domain | Strength training can improve John’s power, explosiveness, shooting accuracy, agility, and speed while helping prevent injuries. Yoga can improve his strength, flexibility, focus, and balance. Daily physical therapy exercises can also support his ankle recovery and return to basketball. | wrong | `D8:5`, `D20:2` |
| `conv-43:55` | temporal | John started playing professionally just under a year before December 6, 2023—around the beginning of 2023. | right | `D1:3`, `D21:4` |
| `conv-43:66` | open-domain | Tim might enjoy a Star Wars novel with epic adventures, rich world-building, and compelling characters. | wrong | `D27:19`, `D27:21` |
| `conv-43:67` | open-domain | Learning foreign languages would be a great hobby for Tim. He already enjoys studying German, and developing his language skills would help him connect with people and explore different cultures on his travels. | wrong | `D4:1`, `D6:6`, `D15:3`, `D27:37` |
| `conv-43:135` | single-hop | Tim breaks studying into smaller chunks: 25 minutes of studying followed by a 5-minute break for something fun. This makes studying less overwhelming and keeps him on track. | wrong | `D18:6` |
| `conv-43:136` | single-hop | Tim said, “I hope your injury heals soon,” and encouraged John to “hang tight” and “keep pushing on.” | wrong | `D18:10` |
| `conv-43:164` | single-hop | French, which he studied in high school. | wrong | `D27:6` |
| `conv-43:166` | single-hop | The Lord of the Rings. | wrong | `D27:19` |
| `conv-44:16` | temporal | Andrew is going hiking with Audrey on Saturday. | wrong | `D11:7` |
| `conv-44:17` | multi-hop | 5 times. | wrong | `D11:7`, `D24:13`, `D26:20` |
| `conv-44:19` | open-domain | Andrew would enjoy playing hide-and-seek with his dog indoors, keeping his pup happy and mentally stimulated. | wrong | `D10:12`, `D12:1` |
| `conv-44:23` | multi-hop | Before adopting Toby, Andrew struggled with: - Finding an affordable-to-rent? | wrong | `D2:12`, `D5:3`, `D5:5`, `D5:7` |
| `conv-44:43` | open-domain | A mountainous U.S. state with national parks, lakes, and winter snow. | wrong | `D11:9` |
| `conv-44:44` | open-domain | A national park with mountain hiking trails and a scenic peak where Audrey watched the sunset with her dogs. | wrong | `D5:8`, `D11:9` |
| `conv-44:52` | open-domain | Andrew could fit short birdwatching sessions into visits to nearby city parks, bringing his binoculars and notebook to spot and record birds during work breaks or on weekends. | wrong | `D20:5`, `D20:21`, `D23:1`, `D1:14` |
| `conv-44:57` | temporal | Andrew adopted Scout shortly before November 22, 2023. | right | `D28:6` |
| `conv-47:11` | temporal | John was feeling busy and stressed by work, with little time for gaming to help him relax. | wrong | `D6:7` |
| `conv-47:17` | open-domain | Among Us. | wrong | `D8:36` |
| `conv-47:31` | temporal | 9 days, from July 11 to July 20, 2022. | wrong | `D16:9`, `D16:13` |
| `conv-48:77` | multi-hop | They found a cool diving spot during their scuba diving lesson last Friday. | wrong | `D27:1`, `D29:4` |
| `conv-48:115` | single-hop | Deborah incorporates a morning jog in the park into her daily routine. | wrong | `D7:18` |
| `conv-48:116` | single-hop | Exercise helps Jolene feel calmer, more relaxed, balanced, and grounded, as well as more alert and motivated. | right | `D7:20` |
| `conv-48:136` | single-hop | Dancer Pose (Natarajasana). | wrong | `D14:15` |
| `conv-48:174` | single-hop | Jolene had to reschedule because Deborah already had plans for the proposed day, Wednesday at 4. They agreed to meet Friday at 5 instead. | right | `D26:15` |
| `conv-48:179` | single-hop | Jolene played “Detroit” on the console with her partner and said they both loved gaming together. | wrong | `D27:12` |
| `conv-49:11` | multi-hop | Sam had a severe stomachache that sent him to the ER, where he was diagnosed with gastritis. This health scare motivated him to eat more nutritiously and exercise regularly. | wrong | `D2:6`, `D3:4`, `D24:12`, `D24:14`, `D5:5`, `D6:2`, `D7:2`, `D7:12`, `D8:1`, `D10:6`, `D12:1`, `D13:2`, `D14:1`, `D15:1`, `D16:3`, `D17:3`, `D24:20`, `D25:1`, `D25:3` |
| `conv-49:24` | temporal | Sam started a new diet and exercise routine in late August 2023, which made a huge difference and left him feeling great. | wrong | `D5:1` |
| `conv-49:80` | temporal | Evan had the drunken night with his friends on January 9, 2024. | wrong | `D24:3` |
| `conv-49:106` | single-hop | Evan started watercolor painting after a friend gave him a painting that inspired him. | right | `D8:14` |
| `conv-49:116` | single-hop | Evan shared a painting of a peaceful sunset, which he said helped him relax. | wrong | `D11:8` |
| `conv-49:144` | single-hop | Evan shared a photo of a lake surrounded by rocks and mountains from his family’s hiking trip to the Canadian Rockies. | wrong | `D22:1` |
| `conv-50:27` | temporal | Tokyo, Japan. | wrong | `D16:6` |
| `conv-50:47` | multi-hop | 4 car shows. | wrong | `D3:12`, `D22:1` |
| `conv-50:109` | single-hop | Calvin is excited to visit Tokyo after the tour, explore Shibuya Crossing and Shinjuku, and try the local food, including ramen. | wrong | `D18:7` |
| `conv-50:137` | single-hop | Calvin was interested in cars by March 2023, when he bought a Ferrari and described driving it as an adrenaline rush. | wrong | `D26:6` |
| `conv-50:147` | single-hop | Calvin boosts his motivation by watching music videos, concerts, and documentaries about artists’ creative processes; collaborating and learning from other musicians; surrounding himself with supportive, positive people; and taking breaks to recharge. He also draws motivation from audience energy, positive feedback, and reminding himself of his passion, goals, and progress. | wrong | `D28:34` |
| `conv-50:151` | single-hop | Calvin recently took up restoring vintage cars. | wrong | `D30:1` |
